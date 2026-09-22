import { readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ClickHouseError } from '@clickhouse/client'
import {
  MAX_RECORD_VERSION,
  SEALED_SEGMENT_RE,
  type SpoolRecord,
  SpoolRecordSchema,
} from '@clickmonk/core'
import type { ClickHouseClient } from '@clickmonk/db'

/** Segments considered per pass. Also the signal `startShipper` uses to go
 * around again immediately: a full pass means more may be waiting. */
export const MAX_SEGMENTS_PER_PASS = 20

/** Refuse to read a sealed segment larger than this. Far above the writer's
 * own 8 MB seal threshold: a corrupt writer, or the wrong file dropped into
 * the spool by hand, never a segment the writer produced. */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024

/**
 * A version 1 record predates classification: it is stored unclassified
 * (an empty class, no signals), never as human.
 */
export function toClickhouseRow(r: SpoolRecord): Record<string, string | number | string[]> {
  return {
    click_id: r.clickId,
    // DateTime64(3) accepts 'YYYY-MM-DD HH:MM:SS.mmm' in UTC.
    time: r.time.replace('T', ' ').replace('Z', ''),
    host: r.host,
    path: r.path,
    domain_id: r.domainId,
    link_id: r.linkId,
    outcome: r.outcome,
    step: r.step,
    status: r.status,
    destination: r.destination ?? '',
    target_id: r.targetId ?? '',
    visitor_id: r.visitorId,
    returning: r.returning ? 1 : 0,
    country: r.country ?? '',
    region: '',
    city: '',
    geo_source: r.v === 2 ? r.geoSource : '',
    device: r.device,
    user_agent: r.userAgent,
    referrer: r.referrer,
    ip: r.ip,
    cap_unchecked: r.capUnchecked ? 1 : 0,
    traffic_class: r.v === 2 ? r.trafficClass : '',
    signals: r.v === 2 ? r.signals : [],
    action: r.v === 2 ? (r.action ?? '') : '',
    os: r.v === 2 ? r.os : '',
    browser: r.v === 2 ? r.browser : '',
    asn: r.v === 2 ? (r.asn ?? 0) : 0,
  }
}

/**
 * ClickHouse error `type`s that mean the server parsed the request and
 * rejected this row's data — a failure that will recur exactly the same way
 * on retry, so the segment is set aside rather than blocking the pass.
 * Everything else — wrong credentials, an overloaded or read-only server, a
 * missing table, a timeout, a Keeper or shutdown error, `ch.insert` never
 * getting a response at all — is a server or transport condition that may
 * well succeed on the next pass, so it stops the pass and backs off instead.
 * `ClickHouseError` alone does not imply the former: the client raises it
 * for any ClickHouse-formatted non-2xx body, including server-state errors
 * (wrong password -> 516 AUTHENTICATION_FAILED; a slow query -> 159
 * TIMEOUT_EXCEEDED; also MEMORY_LIMIT_EXCEEDED, TOO_MANY_PARTS,
 * TOO_MANY_SIMULTANEOUS_QUERIES, TABLE_IS_READ_ONLY, NOT_ENOUGH_SPACE,
 * UNKNOWN_TABLE/DATABASE), so the error `type` itself has to be checked.
 *
 * The `CANNOT_PARSE_*` family covers one failure per column type ClickHouse
 * knows how to reject on read (UUID, DateTime, number, text, bool, IPv4/6,
 * a quoted string, and the generic "assertion failed" ClickHouse raises when
 * a value's shape does not match the column at all — confirmed against the
 * test ClickHouse: an invalid UUID string in a JSONEachRow insert produces
 * `CANNOT_PARSE_INPUT_ASSERTION_FAILED`, code 27). `TYPE_MISMATCH` and
 * `INCORRECT_DATA` are ClickHouse's other two named "this row's data is
 * wrong" errors, not tied to one column type. `UNKNOWN_TABLE`/`UNKNOWN_
 * DATABASE` are deliberately left out even though the client answered: a
 * missing table means every row, forever, until someone fixes the schema —
 * not this segment's rows specifically — so it should stop the pass and
 * keep retrying (and logging) rather than quietly renaming every segment to
 * `.bad`.
 */
const DATA_REJECTION_ERROR_TYPES = new Set(['TYPE_MISMATCH', 'INCORRECT_DATA'])

function isDataRejection(err: unknown): boolean {
  if (!(err instanceof ClickHouseError)) return false
  const type = err.type ?? ''
  return type.startsWith('CANNOT_PARSE_') || DATA_REJECTION_ERROR_TYPES.has(type)
}

/**
 * Renames a segment out of the sealed pool so it is never picked up again,
 * without deleting it: `<name>.bad` no longer matches SEALED_SEGMENT_RE. Used
 * for every segment-local failure (not a regular file, oversized, unreadable,
 * or ClickHouse answering with a rejection), so
 * one bad segment never blocks the ones behind it.
 */
function setAside(path: string, reason: unknown, log: (msg: string, err?: unknown) => void): void {
  try {
    renameSync(path, `${path}.bad`)
    log(`set aside ${path}`, reason)
  } catch (err) {
    log(`could not set aside ${path}; left in place for the next pass`, err)
  }
}

/**
 * Ships up to `maxSegments` sealed segments, oldest first. A segment-local
 * failure (not a regular file, too large, unreadable, or ClickHouse
 * rejecting the data as malformed — see
 * `isDataRejection`) is set aside and shipping continues with the next
 * segment. Every other failure — ClickHouse unreachable, or answering but
 * with a server-state error such as bad credentials or an overloaded server
 * — stops the whole pass instead: every remaining segment, including the one
 * in flight, is left untouched for the next pass.
 *
 * A segment whose rows were accepted but whose file could not be deleted is
 * remembered in `skipUnlinked` (when given) and left off every later pass,
 * rather than being re-inserted on each retry — `click_id` would still
 * deduplicate it, but there is no reason to pay for it.
 *
 * A segment holding a record version newer than this worker knows was
 * written by a newer redirect. It is neither shipped, set aside nor
 * deleted: it stays in the spool, under its own name, for the upgraded
 * worker to ship. It is remembered in `skipNewer` (when given) so this
 * worker does not read it again on every pass.
 */
export async function shipOnce(opts: {
  dir: string
  ch: ClickHouseClient
  maxSegments?: number
  skipUnlinked?: Set<string>
  skipNewer?: Set<string>
  log?: (msg: string, err?: unknown) => void
  /** Filesystem seam for tests: defaults to `fs.unlinkSync`. */
  unlink?: (path: string) => void
}): Promise<{ segments: number; rows: number; malformed: number }> {
  const log = opts.log ?? (() => {})
  const unlink = opts.unlink ?? unlinkSync
  const skip = opts.skipUnlinked
  const files = readdirSync(opts.dir)
    .filter((f) => SEALED_SEGMENT_RE.test(f) && !skip?.has(f) && !opts.skipNewer?.has(f))
    .sort()
    .slice(0, opts.maxSegments ?? MAX_SEGMENTS_PER_PASS)
  let rows = 0
  let malformed = 0
  for (const f of files) {
    const path = join(opts.dir, f)

    try {
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error('not a regular file')
      if (stat.size > MAX_SEGMENT_BYTES)
        throw new Error(`segment exceeds ${MAX_SEGMENT_BYTES} bytes`)
    } catch (err) {
      setAside(path, err, log)
      continue
    }

    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch (err) {
      setAside(path, err, log)
      continue
    }

    const values: Record<string, string | number | string[]>[] = []
    let newerVersion = false
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      // A version above the newest this build knows comes from a newer
      // redirect: its lines must not be read as malformed and thrown away.
      // Anything else that is not a known version is malformed.
      const v = typeof parsed === 'object' && parsed !== null ? (parsed as { v?: unknown }).v : null
      if (typeof v === 'number' && Number.isInteger(v) && v > MAX_RECORD_VERSION) {
        newerVersion = true
        break
      }
      const r = SpoolRecordSchema.safeParse(parsed)
      if (!r.success) {
        malformed++
        continue
      }
      values.push(toClickhouseRow(r.data))
    }

    if (newerVersion) {
      opts.skipNewer?.add(f)
      log(`left ${f} in the spool: it holds a record version newer than this worker ships`)
      continue
    }

    if (values.length > 0) {
      try {
        await opts.ch.insert({ table: 'clicks', values, format: 'JSONEachRow' })
      } catch (err) {
        if (!isDataRejection(err)) throw err
        setAside(path, err, log)
        continue
      }
    }

    try {
      unlink(path)
    } catch (err) {
      skip?.add(f)
      log(`shipped ${f} but could not delete it; will not re-ship it`, err)
      rows += values.length
      continue
    }
    rows += values.length
  }
  return { segments: files.length, rows, malformed }
}

/** Ships continuously. The returned promise of `stop()` resolves after the pass in flight. Never rejects. */
export function startShipper(opts: {
  dir: string
  ch: ClickHouseClient
  intervalMs?: number
  maxBackoffMs?: number
  log?: (msg: string, err?: unknown) => void
}): { stop(): Promise<void> } {
  const interval = opts.intervalMs ?? 1000
  const maxBackoff = opts.maxBackoffMs ?? 30_000
  const log = opts.log ?? (() => {})
  let stopped = false
  let wake: (() => void) | null = null
  // Segments whose rows shipped but whose file could not be deleted: kept
  // off every subsequent pass for the life of this shipper.
  const skipUnlinked = new Set<string>()
  // Segments from a newer redirect, left for an upgraded worker.
  const skipNewer = new Set<string>()

  const loop = (async () => {
    let backoff = interval
    while (!stopped) {
      let delay = interval
      try {
        const r = await shipOnce({ dir: opts.dir, ch: opts.ch, skipUnlinked, skipNewer, log })
        if (r.malformed > 0) log(`skipped ${r.malformed} malformed spool lines`)
        // A full pass means more may be waiting: go again at once.
        if (r.segments >= MAX_SEGMENTS_PER_PASS) delay = 0
        backoff = interval
      } catch (err) {
        log('shipping failed; will retry', err)
        backoff = Math.min(backoff * 2, maxBackoff)
        delay = backoff
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = null
    }
  })()

  return {
    async stop() {
      stopped = true
      wake?.()
      await loop
    },
  }
}
