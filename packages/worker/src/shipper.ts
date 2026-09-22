import { readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ClickHouseError } from '@clickhouse/client'
import { type ClickRecord, ClickRecordSchema, SEALED_SEGMENT_RE } from '@clickmonk/core'
import type { ClickHouseClient } from '@clickmonk/db'

/** Segments considered per pass. Also the signal `startShipper` uses to go
 * around again immediately: a full pass means more may be waiting. */
export const MAX_SEGMENTS_PER_PASS = 20

/** Refuse to read a sealed segment larger than this. Far above the writer's
 * own 8 MB seal threshold: a corrupt writer, or the wrong file dropped into
 * the spool by hand, never a segment the writer produced. */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024

export function toClickhouseRow(r: ClickRecord): Record<string, string | number> {
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
    geo_source: '',
    device: r.device,
    user_agent: r.userAgent,
    referrer: r.referrer,
    ip: r.ip,
    cap_unchecked: r.capUnchecked ? 1 : 0,
  }
}

/**
 * `ch.insert` throws a `ClickHouseError` only once the server has answered,
 * even with a rejection. Anything else — refused, timed out, a DNS failure,
 * a reset socket — never got a response. Only the latter stops a pass: a
 * rejection is this segment's problem, not every segment's.
 */
function isConnectionError(err: unknown): boolean {
  return !(err instanceof ClickHouseError)
}

/**
 * Renames a segment out of the sealed pool so it is never picked up again,
 * without deleting it: `<name>.bad` no longer matches SEALED_SEGMENT_RE. Used
 * for every segment-local failure (not a regular file, oversized, unreadable,
 * an unknown record version, or ClickHouse answering with a rejection), so
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
 * failure (not a regular file, too large, unreadable, an unknown record
 * version, or ClickHouse rejecting the data) is set aside and shipping
 * continues with the next segment. ClickHouse being unreachable stops the
 * whole pass instead: every remaining segment, including the one in flight,
 * is left untouched for the next pass.
 *
 * A segment whose rows were accepted but whose file could not be deleted is
 * remembered in `skipUnlinked` (when given) and left off every later pass,
 * rather than being re-inserted on each retry — `click_id` would still
 * deduplicate it, but there is no reason to pay for it.
 */
export async function shipOnce(opts: {
  dir: string
  ch: ClickHouseClient
  maxSegments?: number
  skipUnlinked?: Set<string>
  log?: (msg: string, err?: unknown) => void
}): Promise<{ segments: number; rows: number; malformed: number }> {
  const log = opts.log ?? (() => {})
  const skip = opts.skipUnlinked
  const files = readdirSync(opts.dir)
    .filter((f) => SEALED_SEGMENT_RE.test(f) && !skip?.has(f))
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

    const values: Record<string, string | number>[] = []
    let unknownVersion = false
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      // A parseable line with a version this build does not understand is
      // not this line's problem to skip: a newer spool format must not be
      // read as malformed and thrown away. Set the whole segment aside.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'v' in parsed &&
        (parsed as { v: unknown }).v !== 1
      ) {
        unknownVersion = true
        break
      }
      const r = ClickRecordSchema.safeParse(parsed)
      if (!r.success) {
        malformed++
        continue
      }
      values.push(toClickhouseRow(r.data))
    }

    if (unknownVersion) {
      setAside(path, new Error('segment contains an unknown record version'), log)
      continue
    }

    if (values.length > 0) {
      try {
        await opts.ch.insert({ table: 'clicks', values, format: 'JSONEachRow' })
      } catch (err) {
        if (isConnectionError(err)) throw err
        setAside(path, err, log)
        continue
      }
    }

    try {
      unlinkSync(path)
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

  const loop = (async () => {
    let backoff = interval
    while (!stopped) {
      let delay = interval
      try {
        const r = await shipOnce({ dir: opts.dir, ch: opts.ch, skipUnlinked, log })
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
