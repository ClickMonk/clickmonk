import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClickRecord, ZERO_UUID } from '@clickmonk/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SpoolWriter } from './spool.js'

const rec = (n: number): ClickRecord => ({
  v: 1,
  clickId: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  time: new Date().toISOString(),
  host: 'go.example.test',
  path: '/s',
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
})

const writers: SpoolWriter[] = []
function writer(dir: string, opts: Partial<ConstructorParameters<typeof SpoolWriter>[0]> = {}) {
  const w = new SpoolWriter({ dir, fsyncIntervalMs: 60_000, maxSegmentAgeMs: 60_000, ...opts })
  w.start()
  writers.push(w)
  return w
}
afterEach(() => {
  for (const w of writers.splice(0)) w.close()
})

const tmp = () => mkdtempSync(join(tmpdir(), 'clickmonk-spool-'))
const sealed = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
const lines = (dir: string) =>
  sealed(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))

describe('SpoolWriter', () => {
  it('writes each record as one JSON line, readable before any fsync or seal', () => {
    const dir = tmp()
    const w = writer(dir)
    expect(w.append(rec(1))).toBe(true)
    const open = readdirSync(dir).filter((f) => f.endsWith('.part'))
    expect(open).toHaveLength(1)
    const text = readFileSync(join(dir, open[0] as string), 'utf8')
    expect(JSON.parse(text.trim()).clickId).toBe(rec(1).clickId)
  })

  it('seals a segment when it reaches the size bound', () => {
    const dir = tmp()
    const w = writer(dir, { maxSegmentBytes: 1000 })
    for (let i = 0; i < 20; i++) w.append(rec(i))
    expect(sealed(dir).length).toBeGreaterThan(1)
    expect(sealed(dir)[0]).toMatch(/^seg-\d{15}-\d+-\d+\.ndjson$/)
  })

  it('seals the open segment on close, losing nothing', () => {
    const dir = tmp()
    const w = writer(dir)
    for (let i = 0; i < 5; i++) w.append(rec(i))
    w.close()
    expect(lines(dir)).toHaveLength(5)
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false)
  })

  it('seals a segment by age on the timer', async () => {
    const dir = tmp()
    const w = writer(dir, { maxSegmentAgeMs: 50, fsyncIntervalMs: 20 })
    w.append(rec(1))
    await new Promise((r) => setTimeout(r, 200))
    expect(lines(dir)).toHaveLength(1)
  })

  it('seals a segment a crashed writer left open, at start', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'open-999-0.part'), `${JSON.stringify(rec(7))}\n`)
    writer(dir)
    expect(existsSync(join(dir, 'open-999-0.part'))).toBe(false)
    expect(lines(dir)).toHaveLength(1)
  })

  it('drops instead of writing past the total bound, and counts it', () => {
    const dir = tmp()
    const one = `${JSON.stringify(rec(0))}\n`.length
    const w = writer(dir, { maxTotalBytes: one * 3, maxSegmentBytes: one })
    const results = Array.from({ length: 5 }, (_, i) => w.append(rec(i)))
    expect(results).toEqual([true, true, true, false, false])
    expect(w.stats().dropped).toBe(2)
  })

  it('accepts writes again once the worker has drained the spool', async () => {
    const dir = tmp()
    const one = `${JSON.stringify(rec(0))}\n`.length
    const w = writer(dir, { maxTotalBytes: one * 2, maxSegmentBytes: one, fsyncIntervalMs: 20 })
    w.append(rec(0))
    w.append(rec(1))
    expect(w.append(rec(2))).toBe(false)
    const { rmSync } = await import('node:fs')
    for (const f of sealed(dir)) rmSync(join(dir, f))
    await new Promise((r) => setTimeout(r, 1200))
    expect(w.append(rec(3))).toBe(true)
  })

  it('never throws from append, even when the directory is gone', async () => {
    const dir = tmp()
    const w = writer(dir, { maxSegmentBytes: 1 })
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
    expect(() => w.append(rec(1))).not.toThrow()
    expect(w.stats().dropped).toBeGreaterThan(0)
  })
})
