import { bucketLabel, localDate } from '@/window/range'

/**
 * A label per bucket for the chart and its table. A day bucket is named by
 * its date, as `bucketLabel` already does. An hour bucket is named by its
 * time alone only while every bucket falls on the same local date; once an
 * hour chart spans more than one local date (any window over a day), the
 * plain time repeats across days — "14:00" on both Tuesday and Wednesday —
 * so every label then carries its day too, and the two stay distinct.
 */
export function chartBucketLabels(
  buckets: { at: string }[],
  bucket: 'hour' | 'day',
  timeZone: string,
): string[] {
  if (bucket === 'day') return buckets.map((b) => bucketLabel(Date.parse(b.at), 'day', timeZone))
  const dates = new Set(buckets.map((b) => localDate(Date.parse(b.at), timeZone)))
  if (dates.size <= 1) return buckets.map((b) => bucketLabel(Date.parse(b.at), 'hour', timeZone))
  return buckets.map((b) => {
    const at = Date.parse(b.at)
    return `${bucketLabel(at, 'day', timeZone)}, ${bucketLabel(at, 'hour', timeZone)}`
  })
}
