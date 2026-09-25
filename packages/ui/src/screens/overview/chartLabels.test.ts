import { describe, expect, it } from 'vitest'
import { chartBucketLabels } from './chartLabels'

const ADL = 'Australia/Adelaide'
const hour = (iso: string) => ({ at: iso })

describe('a chart bucket label', () => {
  it('names a day bucket by its date', () => {
    expect(
      chartBucketLabels(
        [hour('2026-09-30T14:00:00.000Z'), hour('2026-10-01T14:00:00.000Z')],
        'day',
        ADL,
      ),
    ).toEqual(['Thu 1 Oct', 'Fri 2 Oct'])
  })

  it('names an hour bucket by its time alone while every bucket falls on the same local date', () => {
    expect(
      chartBucketLabels(
        [hour('2026-10-07T00:00:00.000Z'), hour('2026-10-07T01:00:00.000Z')],
        'hour',
        ADL,
      ),
    ).toEqual(['10:30', '11:30'])
  })

  // Thirty hourly buckets from 2026-10-07T00:00Z (10:30 local) cross into
  // 2026-10-08 local: the plain hour would repeat ("10:30" twice), so every
  // label here carries its day.
  it('carries the day on every label once an hour chart spans more than one local date, and every label stays distinct', () => {
    const buckets = Array.from({ length: 30 }, (_, i) =>
      hour(new Date(Date.parse('2026-10-07T00:00:00.000Z') + i * 3_600_000).toISOString()),
    )
    const labels = chartBucketLabels(buckets, 'hour', ADL)
    expect(labels[0]).toBe('Wed 7 Oct, 10:30')
    expect(labels[24]).toBe('Thu 8 Oct, 10:30')
    expect(new Set(labels).size).toBe(labels.length)
  })
})
