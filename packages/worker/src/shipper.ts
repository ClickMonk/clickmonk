import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type ClickRecord, ClickRecordSchema, SEALED_SEGMENT_RE } from '@clickmonk/core'
import type { ClickHouseClient } from '@clickmonk/db'

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
 * Ships up to `maxSegments` sealed segments, oldest first. Rejects if
 * ClickHouse refuses a segment; that segment stays on disk for the next pass.
 */
export async function shipOnce(opts: {
  dir: string
  ch: ClickHouseClient
  maxSegments?: number
}): Promise<{ segments: number; rows: number; malformed: number }> {
  const files = readdirSync(opts.dir)
    .filter((f) => SEALED_SEGMENT_RE.test(f))
    .sort()
    .slice(0, opts.maxSegments ?? 20)
  let rows = 0
  let malformed = 0
  for (const f of files) {
    const path = join(opts.dir, f)
    const values: Record<string, string | number>[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      const r = ClickRecordSchema.safeParse(parsed)
      if (!r.success) {
        malformed++
        continue
      }
      values.push(toClickhouseRow(r.data))
    }
    if (values.length > 0) await opts.ch.insert({ table: 'clicks', values, format: 'JSONEachRow' })
    unlinkSync(path)
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

  const loop = (async () => {
    let backoff = interval
    while (!stopped) {
      let delay = interval
      try {
        const r = await shipOnce({ dir: opts.dir, ch: opts.ch })
        if (r.malformed > 0) log(`skipped ${r.malformed} malformed spool lines`)
        // A full pass means more may be waiting: go again at once.
        if (r.segments >= 20) delay = 0
        backoff = interval
      } catch (err) {
        log('shipping failed; will retry', err)
        backoff = Math.min(Math.max(backoff * 2, interval), maxBackoff)
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
