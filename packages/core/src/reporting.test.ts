import { describe, expect, it } from 'vitest'
import {
  BUCKET_MS,
  KEYED_DIMENSIONS,
  MAX_REPORT_BUCKETS,
  MAX_REPORT_WINDOW_DAYS,
  REPORT_BUCKETS,
  REPORT_DIMENSIONS,
  ROLLUP_DIMENSIONS,
  bucketCount,
  isKeyedDimension,
} from './reporting.js'

const at = (iso: string): number => Date.parse(iso)

describe('bucketCount', () => {
  it('counts the hours a window touches, not the hours it lasts', () => {
    // Twenty minutes, straddling an hour boundary: two bars on a chart.
    expect(bucketCount(at('2026-09-24T10:50:00Z'), at('2026-09-24T11:10:00Z'), 'hour')).toBe(2)
    // Twenty minutes inside one hour: one bar.
    expect(bucketCount(at('2026-09-24T10:20:00Z'), at('2026-09-24T10:40:00Z'), 'hour')).toBe(1)
  })

  it('treats the window as half-open, so a whole hour is one bucket', () => {
    expect(bucketCount(at('2026-09-24T10:00:00Z'), at('2026-09-24T11:00:00Z'), 'hour')).toBe(1)
    expect(bucketCount(at('2026-09-24T10:00:00Z'), at('2026-09-24T11:00:00.001Z'), 'hour')).toBe(2)
  })

  it('counts days the same way', () => {
    expect(bucketCount(at('2026-09-24T00:00:00Z'), at('2026-09-25T00:00:00Z'), 'day')).toBe(1)
    expect(bucketCount(at('2026-09-24T23:59:59Z'), at('2026-09-25T00:00:01Z'), 'day')).toBe(2)
    expect(bucketCount(at('2026-09-01T00:00:00Z'), at('2026-10-01T00:00:00Z'), 'day')).toBe(30)
  })

  it('answers zero for an empty or backwards window', () => {
    expect(bucketCount(at('2026-09-24T10:00:00Z'), at('2026-09-24T10:00:00Z'), 'hour')).toBe(0)
    expect(bucketCount(at('2026-09-24T11:00:00Z'), at('2026-09-24T10:00:00Z'), 'hour')).toBe(0)
  })

  // The two numbers the chart endpoint refuses a window with. Written out
  // rather than computed from the constants, so changing either constant
  // fails here first.
  it('puts a year of hours inside the bucket ceiling and 400 days of hours outside it', () => {
    expect(bucketCount(at('2025-09-24T00:00:00Z'), at('2026-09-24T00:00:00Z'), 'hour')).toBe(8760)
    expect(MAX_REPORT_BUCKETS).toBe(2000)
    expect(MAX_REPORT_WINDOW_DAYS).toBe(400)
    expect(BUCKET_MS).toEqual({ hour: 3_600_000, day: 86_400_000 })
  })
})

describe('the dimensions a breakdown may name', () => {
  it('is the six the per-dimension rollup holds and the three that key the hourly one', () => {
    expect(ROLLUP_DIMENSIONS).toEqual(['country', 'device', 'os', 'browser', 'referrer', 'target'])
    expect(KEYED_DIMENSIONS).toEqual(['class', 'action', 'outcome'])
    expect(REPORT_DIMENSIONS).toEqual([
      'country',
      'device',
      'os',
      'browser',
      'referrer',
      'target',
      'class',
      'action',
      'outcome',
    ])
    expect(REPORT_BUCKETS).toEqual(['hour', 'day'])
  })

  it('says which table each one is answered from', () => {
    expect(isKeyedDimension('class')).toBe(true)
    expect(isKeyedDimension('outcome')).toBe(true)
    expect(isKeyedDimension('country')).toBe(false)
    expect(isKeyedDimension('referrer')).toBe(false)
  })
})
