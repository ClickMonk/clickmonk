import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClickHouseLogLevel } from '@clickhouse/client'
import { type ClickRecord, ZERO_UUID, segmentName } from '@clickmonk/core'
import { createChClient } from '@clickmonk/db'
import { TEST_CH, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SEGMENT_BYTES, shipOnce, startShipper, toClickhouseRow } from './shipper.js'

// The dead-client tests below deliberately connect to a closed port; this
// silences the client's own connection-error logging for those, not ours.
const deadCh = () =>
  createChClient({ ...TEST_CH, url: 'http://127.0.0.1:1', logLevel: ClickHouseLogLevel.OFF })

const pg = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pg, ch)
})
beforeEach(async () => {
  await ch.command({ query: 'TRUNCATE TABLE clicks' })
})
afterAll(async () => {
  await pg.end()
  await ch.close()
})

let n = 0
const rec = (over: Partial<ClickRecord> = {}): ClickRecord => ({
  v: 1,
  clickId: `01920000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  time: new Date().toISOString(),
  host: 'go.example.test',
  path: '/spring',
  domainId: ZERO_UUID,
  linkId: ZERO_UUID,
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/',
  targetId: null,
  visitorId: 'v',
  returning: false,
  device: 'desktop',
  country: null,
  userAgent: 'ua',
  referrer: '',
  ip: '192.0.2.1',
  capUnchecked: false,
  ...over,
})

const tmp = () => mkdtempSync(join(tmpdir(), 'clickmonk-ship-'))
let seq = 0
function segment(dir: string, lines: string[]): string {
  const name = segmentName(Date.now(), 1, seq++)
  writeFileSync(join(dir, name), `${lines.join('\n')}\n`)
  return name
}
async function clicks(): Promise<number> {
  const rs = await ch.query({
    query: 'SELECT uniqExact(click_id) AS n FROM clicks',
    format: 'JSONEachRow',
  })
  const [r] = await rs.json<{ n: string }>()
  return Number(r?.n)
}
// Raw row count, not deduplicated by click_id: proves whether a second
// insert actually happened, which uniqExact alone cannot (a re-shipped
// segment is deduplicated away, not prevented).
async function rawRowCount(): Promise<number> {
  const rs = await ch.query({ query: 'SELECT count() AS n FROM clicks', format: 'JSONEachRow' })
  const [r] = await rs.json<{ n: string }>()
  return Number(r?.n)
}

describe('toClickhouseRow', () => {
  it('formats time for DateTime64 and flattens nulls and booleans', () => {
    const r = toClickhouseRow(
      rec({ time: '2026-09-19T12:34:56.789Z', returning: true, country: 'DE' }),
    )
    expect(r).toMatchObject({
      time: '2026-09-19 12:34:56.789',
      returning: 1,
      country: 'DE',
      target_id: '',
      region: '',
      city: '',
      geo_source: '',
    })
  })
})

describe('shipOnce', () => {
  it('inserts every sealed segment and deletes it', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(rec()), JSON.stringify(rec())])
    segment(dir, [JSON.stringify(rec())])
    const r = await shipOnce({ dir, ch })
    expect(r).toEqual({ segments: 2, rows: 3, malformed: 0 })
    expect(await clicks()).toBe(3)
    expect(readdirSync(dir)).toEqual([])
  })

  it('never touches the segment the redirect is still writing', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'open-1-0.part'), `${JSON.stringify(rec())}\n`)
    await shipOnce({ dir, ch })
    expect(readdirSync(dir)).toEqual(['open-1-0.part'])
    expect(await clicks()).toBe(0)
  })

  it('skips and counts malformed lines, and still ships the rest', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(rec()), '{"torn":', JSON.stringify({ ...rec(), outcome: 'nope' })])
    const r = await shipOnce({ dir, ch })
    expect(r).toMatchObject({ rows: 1, malformed: 2 })
    expect(await clicks()).toBe(1)
  })

  it('skips a torn final line (no trailing newline, cut mid-write) and still ships the rest', async () => {
    const dir = tmp()
    const name = segmentName(Date.now(), 1, seq++)
    const whole = JSON.stringify(rec())
    const torn = JSON.stringify(rec()).slice(0, 20)
    // No trailing newline: what renaming a crashed writer's .part produces
    // when the crash lands mid-line.
    writeFileSync(join(dir, name), `${whole}\n${torn}`)
    const r = await shipOnce({ dir, ch })
    expect(r).toEqual({ segments: 1, rows: 1, malformed: 1 })
    expect(await clicks()).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('counts a segment shipped twice once', async () => {
    const dir = tmp()
    const name = segment(dir, [JSON.stringify(rec()), JSON.stringify(rec())])
    // Same lines under another sealed name: what a crash between insert and delete produces.
    copyFileSync(join(dir, name), join(dir, name.replace('-1-', '-2-')))
    await shipOnce({ dir, ch })
    expect(await clicks()).toBe(2)
  })

  it('keeps every segment on disk, untouched, when ClickHouse is unreachable', async () => {
    const dir = tmp()
    const a = segment(dir, [JSON.stringify(rec())])
    const b = segment(dir, [JSON.stringify(rec())])
    const dead = deadCh()
    await expect(shipOnce({ dir, ch: dead })).rejects.toThrow()
    // Neither shipped, neither set aside: a connection failure is not this
    // segment's problem, unlike a rejection the server actually answered.
    expect(readdirSync(dir).sort()).toEqual([a, b].sort())
    await dead.close()
  })

  it('sets aside a segment that is not a regular file, and still ships the good one behind it', async () => {
    const dir = tmp()
    // Named to sort before the good segment, so it is picked up first —
    // reproduces a directory landing where a sealed segment name is expected.
    const probeName = segmentName(1, 1, seq++)
    const goodName = segmentName(2, 1, seq++)
    mkdirSync(join(dir, probeName))
    writeFileSync(join(dir, goodName), `${JSON.stringify(rec())}\n`)
    const r = await shipOnce({ dir, ch })
    expect(r.rows).toBe(1)
    expect(await clicks()).toBe(1)
    // The good segment shipped and was deleted; only the set-aside probe remains.
    expect(readdirSync(dir)).toEqual([`${probeName}.bad`])
  })

  it('remembers a segment whose rows shipped but could not be deleted, and never re-inserts it', async () => {
    const dir = tmp()
    const name = segment(dir, [JSON.stringify(rec())])
    const path = join(dir, name)
    // ext4's immutable attribute: unlink fails even for root, a real
    // permission failure rather than a mock.
    execFileSync('chattr', ['+i', path])
    const skipUnlinked = new Set<string>()
    try {
      const r1 = await shipOnce({ dir, ch, skipUnlinked, log: () => {} })
      expect(r1.rows).toBe(1)
      expect(skipUnlinked.has(name)).toBe(true)
      expect(readdirSync(dir)).toEqual([name])

      const before = await rawRowCount()
      const r2 = await shipOnce({ dir, ch, skipUnlinked, log: () => {} })
      expect(r2.segments).toBe(0)
      expect(r2.rows).toBe(0)
      expect(await rawRowCount()).toBe(before)
    } finally {
      execFileSync('chattr', ['-i', path])
    }
  })

  it('sets aside a segment larger than the size cap without reading it', async () => {
    const dir = tmp()
    const name = segmentName(Date.now(), 1, seq++)
    // A sparse file: only its reported size matters, the cap must trip
    // before any attempt is made to read it.
    writeFileSync(join(dir, name), '')
    truncateSync(join(dir, name), MAX_SEGMENT_BYTES + 1)
    const r = await shipOnce({ dir, ch, maxSegments: 1 })
    expect(r).toMatchObject({ rows: 0, malformed: 0 })
    expect(readdirSync(dir)).toEqual([`${name}.bad`])
    expect(await clicks()).toBe(0)
  })

  it('sets aside a segment holding a record with an unrecognized version, instead of dropping just that line', async () => {
    const dir = tmp()
    const name = segment(dir, [JSON.stringify(rec()), JSON.stringify({ ...rec(), v: 2 })])
    const r = await shipOnce({ dir, ch })
    expect(r).toMatchObject({ rows: 0, malformed: 0 })
    expect(readdirSync(dir)).toEqual([`${name}.bad`])
    expect(await clicks()).toBe(0)
  })

  it('ships the oldest segment first', async () => {
    const dir = tmp()
    writeFileSync(join(dir, segmentName(2, 1, 0)), `${JSON.stringify(rec())}\n`)
    writeFileSync(join(dir, segmentName(1, 1, 0)), `${JSON.stringify(rec())}\n`)
    await shipOnce({ dir, ch, maxSegments: 1 })
    expect(readdirSync(dir)).toEqual([segmentName(2, 1, 0)])
  })

  it('ships at most maxSegments per pass', async () => {
    const dir = tmp()
    for (let i = 0; i < 5; i++) segment(dir, [JSON.stringify(rec())])
    const r = await shipOnce({ dir, ch, maxSegments: 2 })
    expect(r.segments).toBe(2)
    expect(readdirSync(dir)).toHaveLength(3)
  })
})

describe('startShipper', () => {
  it('keeps shipping on its own, and stop() resolves', async () => {
    const dir = tmp()
    const s = startShipper({ dir, ch, intervalMs: 20, log: () => {} })
    segment(dir, [JSON.stringify(rec())])
    const end = Date.now() + 3000
    while ((await clicks()) < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    await s.stop()
    expect(await clicks()).toBe(1)
  })

  it('survives ClickHouse being unreachable, without rejecting', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(rec())])
    const dead = deadCh()
    const s = startShipper({ dir, ch: dead, intervalMs: 20, maxBackoffMs: 50, log: () => {} })
    await new Promise((r) => setTimeout(r, 200))
    await s.stop()
    expect(readdirSync(dir)).toHaveLength(1)
    await dead.close()
  })
})
