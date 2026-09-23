import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClickHouseLogLevel } from '@clickhouse/client'
import { type ClickRecordV1, type ClickRecordV2, ZERO_UUID, segmentName } from '@clickmonk/core'
import { createChClient } from '@clickmonk/db'
import { TEST_CH, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_SEGMENTS_PER_PASS,
  MAX_SEGMENT_BYTES,
  shipOnce,
  startShipper,
  toClickhouseRow,
} from './shipper.js'

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
const rec = (over: Partial<ClickRecordV2> = {}): ClickRecordV2 => ({
  v: 2,
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
  trafficClass: 'human',
  signals: [],
  action: null,
  os: 'windows',
  browser: 'chrome',
  asn: 64500,
  geoSource: 'dbip-country-lite/2026-01',
  ...over,
})

/** A record as a redirect from before traffic classification wrote it. */
const recV1 = (): ClickRecordV1 => {
  const { trafficClass, signals, action, os, browser, asn, geoSource, ...common } = rec()
  return { ...common, v: 1, outcome: 'target', step: 'destination' }
}

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
      geo_source: 'dbip-country-lite/2026-01',
      traffic_class: 'human',
      signals: [],
      action: '',
      os: 'windows',
      browser: 'chrome',
      asn: 64500,
    })
  })

  // Version 3 carries exactly version 2's fields and differs only in the
  // outcome and step it may name, so one mapping reads both. A mapping that
  // tested `v === 2` would store every version 3 click unclassified — a
  // silent loss of the class, the signals, the action, the ASN and the geo
  // source on every click the current redirect writes.
  it('reads a version 3 record exactly as a version 2 one, and keeps its password outcome', () => {
    const base = rec({
      clickId: '01920000-0000-7000-8000-0000000000c3',
      time: '2026-09-19T12:34:56.789Z',
    })
    const r = toClickhouseRow({
      ...base,
      v: 3,
      outcome: 'password',
      step: 'password',
      status: 200,
    })
    // The whole row, so a field silently dropped or blanked fails here.
    expect(r).toEqual({
      click_id: '01920000-0000-7000-8000-0000000000c3',
      time: '2026-09-19 12:34:56.789',
      host: 'go.example.test',
      path: '/spring',
      domain_id: ZERO_UUID,
      link_id: ZERO_UUID,
      outcome: 'password',
      step: 'password',
      status: 200,
      destination: 'https://example.com/',
      target_id: '',
      visitor_id: 'v',
      returning: 0,
      country: '',
      region: '',
      city: '',
      geo_source: 'dbip-country-lite/2026-01',
      device: 'desktop',
      user_agent: 'ua',
      referrer: '',
      ip: '192.0.2.1',
      cap_unchecked: 0,
      traffic_class: 'human',
      signals: [],
      action: '',
      os: 'windows',
      browser: 'chrome',
      asn: 64500,
    })
  })

  it('stores a version 1 record unclassified, not as human', () => {
    expect(toClickhouseRow(recV1())).toMatchObject({
      traffic_class: '',
      signals: [],
      action: '',
      os: '',
      browser: '',
      asn: 0,
      geo_source: '',
    })
  })
})

describe('shipOnce', () => {
  it('inserts every sealed segment and deletes it', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(rec()), JSON.stringify(rec())])
    segment(dir, [JSON.stringify(rec())])
    const r = await shipOnce({ dir, ch, skipNewer: new Set() })
    expect(r).toEqual({ segments: 2, rows: 3, malformed: 0 })
    expect(await clicks()).toBe(3)
    expect(readdirSync(dir)).toEqual([])
  })

  it('never touches the segment the redirect is still writing', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'open-1-0.part'), `${JSON.stringify(rec())}\n`)
    await shipOnce({ dir, ch, skipNewer: new Set() })
    expect(readdirSync(dir)).toEqual(['open-1-0.part'])
    expect(await clicks()).toBe(0)
  })

  it('skips and counts malformed lines, and still ships the rest', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(rec()), '{"torn":', JSON.stringify({ ...rec(), outcome: 'nope' })])
    const r = await shipOnce({ dir, ch, skipNewer: new Set() })
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
    const r = await shipOnce({ dir, ch, skipNewer: new Set() })
    expect(r).toEqual({ segments: 1, rows: 1, malformed: 1 })
    expect(await clicks()).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('counts a segment shipped twice once', async () => {
    const dir = tmp()
    const name = segment(dir, [JSON.stringify(rec()), JSON.stringify(rec())])
    // Same lines under another sealed name: what a crash between insert and delete produces.
    copyFileSync(join(dir, name), join(dir, name.replace('-1-', '-2-')))
    await shipOnce({ dir, ch, skipNewer: new Set() })
    expect(await clicks()).toBe(2)
  })

  it('keeps every segment on disk, untouched, when ClickHouse is unreachable', async () => {
    const dir = tmp()
    const a = segment(dir, [JSON.stringify(rec())])
    const b = segment(dir, [JSON.stringify(rec())])
    const dead = deadCh()
    await expect(shipOnce({ dir, ch: dead, skipNewer: new Set() })).rejects.toThrow()
    // Neither shipped, neither set aside: a connection failure is not this
    // segment's problem, unlike a rejection the server actually answered.
    expect(readdirSync(dir).sort()).toEqual([a, b].sort())
    await dead.close()
  })

  it('keeps every segment on disk, untouched, when ClickHouse answers with a server-state error', async () => {
    const dir = tmp()
    const a = segment(dir, [JSON.stringify(rec())])
    const b = segment(dir, [JSON.stringify(rec())])
    // A real ClickHouseError, but not a data rejection: wrong credentials
    // against the real (reachable) test ClickHouse. Answered, not refused —
    // the opposite failure shape from the test above, and must be handled
    // the same way: stop the pass, touch nothing.
    const badAuth = createChClient({
      ...TEST_CH,
      password: 'wrong-password',
      logLevel: ClickHouseLogLevel.OFF,
    })
    await expect(shipOnce({ dir, ch: badAuth, skipNewer: new Set() })).rejects.toThrow()
    expect(readdirSync(dir).sort()).toEqual([a, b].sort())
    await badAuth.close()
  })

  it('sets aside a segment ClickHouse rejects as malformed data, and still ships the good one behind it', async () => {
    const dir = tmp()
    // SpoolRecordSchema already enforces the same shape ClickHouse's own
    // column types accept (UUID, DateTime64, UInt16, UInt8), and ClickHouse's
    // JSON parser is lenient beyond that (a malformed-looking UUID like
    // "zzzz...z" is silently coerced, not rejected — checked by hand against
    // the test ClickHouse). So no record that reaches here through the spool
    // can actually diverge from what ClickHouse accepts: there is no valid
    // spool line to write for this test. Instead, the outbound insert for
    // the first segment processed is tampered with directly — the spool
    // file stays fully valid, only the bytes that would leave this process
    // are corrupted — so the request ClickHouse actually refuses is a real
    // one, from the real test ClickHouse, not a fabricated error object.
    const badCh = createChClient({ ...TEST_CH, logLevel: ClickHouseLogLevel.OFF })
    let corrupted = false
    const realInsert = badCh.insert.bind(badCh)
    badCh.insert = ((params: Parameters<typeof realInsert>[0]) => {
      if (corrupted) return realInsert(params)
      corrupted = true
      const values = (params.values as Record<string, unknown>[]).map((v) => ({
        ...v,
        click_id: 'not-a-uuid',
      }))
      return realInsert({ ...params, values })
    }) as typeof realInsert

    const badName = segmentName(1, 1, seq++)
    const goodName = segmentName(2, 1, seq++)
    writeFileSync(join(dir, badName), `${JSON.stringify(rec())}\n`)
    writeFileSync(join(dir, goodName), `${JSON.stringify(rec())}\n`)

    const r = await shipOnce({ dir, ch: badCh, skipNewer: new Set(), maxSegments: 2 })
    expect(r.rows).toBe(1)
    expect(readdirSync(dir)).toEqual([`${badName}.bad`])
    expect(await clicks()).toBe(1)
    await badCh.close()
  })

  it('sets aside a segment that is not a regular file, and still ships the good one behind it', async () => {
    const dir = tmp()
    // Named to sort before the good segment, so it is picked up first —
    // reproduces a directory landing where a sealed segment name is expected.
    const probeName = segmentName(1, 1, seq++)
    const goodName = segmentName(2, 1, seq++)
    mkdirSync(join(dir, probeName))
    writeFileSync(join(dir, goodName), `${JSON.stringify(rec())}\n`)
    const r = await shipOnce({ dir, ch, skipNewer: new Set() })
    expect(r.rows).toBe(1)
    expect(await clicks()).toBe(1)
    // The good segment shipped and was deleted; only the set-aside probe remains.
    expect(readdirSync(dir)).toEqual([`${probeName}.bad`])
  })

  it('remembers a segment whose rows shipped but could not be deleted, and never re-inserts it', async () => {
    const dir = tmp()
    const name = segment(dir, [JSON.stringify(rec())])
    const skipUnlinked = new Set<string>()
    let unlinkCalls = 0
    // A filesystem seam, not a database mock: the row still goes to real
    // ClickHouse. Throws once (a real EPERM's shape), then would behave like
    // the real fs.unlinkSync — though nothing here calls it a second time,
    // since a remembered segment is never revisited.
    const flakyUnlink = (path: string) => {
      unlinkCalls++
      if (unlinkCalls === 1) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
      }
      unlinkSync(path)
    }

    const r1 = await shipOnce({
      dir,
      ch,
      skipNewer: new Set(),
      skipUnlinked,
      log: () => {},
      unlink: flakyUnlink,
    })
    expect(r1.rows).toBe(1)
    expect(skipUnlinked.has(name)).toBe(true)
    expect(readdirSync(dir)).toEqual([name])

    const before = await rawRowCount()
    const r2 = await shipOnce({
      dir,
      ch,
      skipNewer: new Set(),
      skipUnlinked,
      log: () => {},
      unlink: flakyUnlink,
    })
    expect(r2.segments).toBe(0)
    expect(r2.rows).toBe(0)
    expect(await rawRowCount()).toBe(before)
  })

  it('sets aside a segment larger than the size cap without reading it', async () => {
    const dir = tmp()
    const name = segmentName(Date.now(), 1, seq++)
    // A sparse file: only its reported size matters, the cap must trip
    // before any attempt is made to read it.
    writeFileSync(join(dir, name), '')
    truncateSync(join(dir, name), MAX_SEGMENT_BYTES + 1)
    const r = await shipOnce({ dir, ch, skipNewer: new Set(), maxSegments: 1 })
    expect(r).toMatchObject({ rows: 0, malformed: 0 })
    expect(readdirSync(dir)).toEqual([`${name}.bad`])
    expect(await clicks()).toBe(0)
  })

  it('ships version 1 and version 2 segments side by side', async () => {
    const dir = tmp()
    segment(dir, [JSON.stringify(recV1())])
    segment(dir, [
      JSON.stringify(rec({ trafficClass: 'bot', signals: ['ua_bot'], action: 'flag' })),
    ])
    expect(await shipOnce({ dir, ch, skipNewer: new Set() })).toEqual({
      segments: 2,
      rows: 2,
      malformed: 0,
    })
    const rs = await ch.query({
      query: 'SELECT traffic_class, signals, action FROM clicks ORDER BY traffic_class',
      format: 'JSONEachRow',
    })
    expect(await rs.json()).toEqual([
      { traffic_class: '', signals: [], action: '' },
      { traffic_class: 'bot', signals: ['ua_bot'], action: 'flag' },
    ])
  })

  it('leaves a segment from a newer redirect in the spool, untouched, and ships the rest', async () => {
    const dir = tmp()
    // A malformed line ahead of the newer record is not reported: the
    // segment is not this worker's to judge.
    const newer = segment(dir, [
      JSON.stringify(rec()),
      '{"torn":',
      JSON.stringify({ ...rec(), v: 4 }),
    ])
    segment(dir, [JSON.stringify(rec())])
    const skipNewer = new Set<string>()
    const r = await shipOnce({ dir, ch, skipNewer })
    // The segment left in place is not counted as work done.
    expect(r).toEqual({ segments: 1, rows: 1, malformed: 0 })
    // Not deleted, not renamed to .bad: an upgraded worker ships it as it is.
    expect(readdirSync(dir)).toEqual([newer])
    expect(await clicks()).toBe(1)
    // Not read again by this worker: a second pass does not reach it.
    const logged: string[] = []
    expect(await shipOnce({ dir, ch, skipNewer, log: (m) => logged.push(m) })).toMatchObject({
      segments: 0,
    })
    expect(logged).toEqual([])
  })

  it('reports no work for a pass that found only newer segments, so the shipper waits its interval', async () => {
    const dir = tmp()
    for (let i = 0; i < MAX_SEGMENTS_PER_PASS; i++) {
      writeFileSync(join(dir, segmentName(1 + i, 1, 0)), `${JSON.stringify({ ...rec(), v: 4 })}\n`)
    }
    expect(await shipOnce({ dir, ch, skipNewer: new Set() })).toEqual({
      segments: 0,
      rows: 0,
      malformed: 0,
    })
    expect(readdirSync(dir)).toHaveLength(MAX_SEGMENTS_PER_PASS)
  })

  it('counts a line with a version that is not a newer integer as malformed', async () => {
    const dir = tmp()
    segment(dir, [
      JSON.stringify({ ...rec(), v: 0 }),
      JSON.stringify({ ...rec(), v: 2.5 }),
      JSON.stringify(rec()),
    ])
    expect(await shipOnce({ dir, ch, skipNewer: new Set() })).toEqual({
      segments: 1,
      rows: 1,
      malformed: 2,
    })
    expect(readdirSync(dir)).toEqual([])
  })

  it('ships the oldest segment first', async () => {
    const dir = tmp()
    writeFileSync(join(dir, segmentName(2, 1, 0)), `${JSON.stringify(rec())}\n`)
    writeFileSync(join(dir, segmentName(1, 1, 0)), `${JSON.stringify(rec())}\n`)
    await shipOnce({ dir, ch, skipNewer: new Set(), maxSegments: 1 })
    expect(readdirSync(dir)).toEqual([segmentName(2, 1, 0)])
  })

  it('ships at most maxSegments per pass', async () => {
    const dir = tmp()
    for (let i = 0; i < 5; i++) segment(dir, [JSON.stringify(rec())])
    const r = await shipOnce({ dir, ch, skipNewer: new Set(), maxSegments: 2 })
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

  it('ships a segment behind a full pass of newer segments', async () => {
    const dir = tmp()
    for (let i = 0; i < MAX_SEGMENTS_PER_PASS; i++) {
      writeFileSync(join(dir, segmentName(1 + i, 1, 0)), `${JSON.stringify({ ...rec(), v: 4 })}\n`)
    }
    writeFileSync(join(dir, segmentName(1000, 1, 0)), `${JSON.stringify(rec())}\n`)
    const s = startShipper({ dir, ch, intervalMs: 20, log: () => {} })
    const end = Date.now() + 3000
    while ((await clicks()) < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    await s.stop()
    expect(await clicks()).toBe(1)
    expect(readdirSync(dir)).toHaveLength(MAX_SEGMENTS_PER_PASS)
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
