import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClickRecord, ZERO_UUID } from '@clickmonk/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpoolWriter } from './spool.js'

// A real `node:fs` module namespace can't be spied on directly under ESM
// ("Module namespace is not configurable"), so `renameSync` is routed
// through a swappable hook instead. Every other export, and `renameSync`
// itself outside the one test that sets the hook, stays the real
// implementation used against real temp directories.
const renameHook = vi.hoisted(() => ({ impl: null as ((from: string, to: string) => void) | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renameHook.impl) return renameHook.impl(from, to)
      return actual.renameSync(from, to)
    },
  }
})

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
  renameHook.impl = null
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

  it('counts the open segment toward the total bound, not just sealed bytes', () => {
    const dir = tmp()
    const one = `${JSON.stringify(rec(0))}\n`.length
    // A segment bound far larger than anything written here, so nothing
    // seals during the test: every byte stays in the open segment, and the
    // total-bound check has to add segBytes in, not just sealedBytes (which
    // stays 0 throughout).
    const w = writer(dir, { maxTotalBytes: one * 3, maxSegmentBytes: one * 100 })
    const results = Array.from({ length: 5 }, (_, i) => w.append(rec(i)))
    expect(results).toEqual([true, true, true, false, false])
    expect(w.stats().dropped).toBe(2)
    expect(sealed(dir)).toHaveLength(0)
  })

  it('accepts writes again once the worker has drained the spool', async () => {
    const dir = tmp()
    const one = `${JSON.stringify(rec(0))}\n`.length
    const w = writer(dir, { maxTotalBytes: one * 2, maxSegmentBytes: one, fsyncIntervalMs: 20 })
    w.append(rec(0))
    w.append(rec(1))
    expect(w.append(rec(2))).toBe(false)
    for (const f of sealed(dir)) rmSync(join(dir, f))
    // The re-measure fires on elapsed time (~1000ms), not a fixed tick
    // count, so it lands regardless of timer jitter; the extra margin here
    // is slack for a slow CI box, not a dependency on exact tick timing.
    await new Promise((r) => setTimeout(r, 1500))
    expect(w.append(rec(3))).toBe(true)
  })

  it('never throws from append, even when the directory is gone, and reports false with the error', () => {
    const dir = tmp()
    const onError = vi.fn()
    const w = writer(dir, { maxSegmentBytes: 1, onError })
    rmSync(dir, { recursive: true, force: true })
    let result: boolean | undefined
    expect(() => {
      result = w.append(rec(1))
    }).not.toThrow()
    expect(result).toBe(false)
    expect(w.stats().dropped).toBeGreaterThan(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('drops instead of writing after close, opening no new segment', () => {
    const dir = tmp()
    const w = writer(dir)
    w.append(rec(1))
    w.close()
    expect(w.append(rec(2))).toBe(false)
    expect(w.stats().dropped).toBe(1)
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false)
  })

  it('tick catches its own errors, so a re-measure against a missing directory never crashes the process', async () => {
    const dir = tmp()
    const onError = vi.fn()
    writer(dir, { fsyncIntervalMs: 20, onError }).append(rec(1))
    rmSync(dir, { recursive: true, force: true })
    // Past the ~1000ms elapsed-time re-measure mark; a real, uncaught
    // exception from inside the timer callback would fail this test run.
    await new Promise((r) => setTimeout(r, 1500))
    expect(onError).toHaveBeenCalled()
  })

  it('keeps a seal pending and retries its rename on the next tick, without dropping the write', async () => {
    const dir = tmp()
    const onError = vi.fn()
    const w = writer(dir, { maxSegmentBytes: 1, fsyncIntervalMs: 20, onError })
    renameHook.impl = () => {
      throw new Error('simulated rename failure')
    }
    // The write itself succeeds; only the seal that follows (triggered by
    // the 1-byte segment bound) fails to rename.
    expect(w.append(rec(1))).toBe(true)
    expect(w.stats().dropped).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(true)
    expect(sealed(dir)).toHaveLength(0)

    // Let the next tick's retry use the real rename.
    renameHook.impl = null
    await new Promise((r) => setTimeout(r, 200))
    expect(sealed(dir)).toHaveLength(1)
    expect(lines(dir)).toHaveLength(1)
  })

  it('retries every pending seal, not only the most recent, after two rename failures', async () => {
    const dir = tmp()
    const onError = vi.fn()
    const w = writer(dir, { maxSegmentBytes: 1, fsyncIntervalMs: 20, onError })
    renameHook.impl = () => {
      throw new Error('simulated rename failure')
    }
    // Two appends, each crossing the 1-byte segment bound, each triggering
    // its own failed seal. Both happen synchronously, one after the other,
    // before any tick gets a chance to retry either — so a single pending
    // slot would be overwritten by the second before it is ever retried.
    expect(w.append(rec(1))).toBe(true)
    expect(w.append(rec(2))).toBe(true)
    expect(w.stats().dropped).toBe(0)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toHaveLength(2)
    expect(sealed(dir)).toHaveLength(0)

    // Let the next tick's retries use the real rename.
    renameHook.impl = null
    await new Promise((r) => setTimeout(r, 200))
    expect(sealed(dir)).toHaveLength(2)
    expect(lines(dir)).toHaveLength(2)
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false)
  })
})
