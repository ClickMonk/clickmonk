/**
 * Column chart geometry, as a pure function so it can be tested without a
 * browser: one rectangle per value, in a box, on a linear scale to a round
 * maximum.
 *
 * Every value is drawn, a zero as a column of no height on the baseline. The
 * service fills the buckets nothing happened in with zeros, and a chart that
 * dropped them would draw an outage as traffic that carried on.
 *
 * Linear, because an operator compares these counts against each other and
 * against a cap, and a compressed scale misleads on exactly that comparison.
 */

/** The smallest of 1, 2 or 5 times a power of ten at or above `v`. At least 1. */
export function niceMax(v: number): number {
  if (v <= 1) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

export function columns(
  values: number[],
  box: { width: number; height: number; gap: number },
): { max: number; bars: { x: number; y: number; width: number; height: number }[] } {
  const max = niceMax(Math.max(0, ...values))
  if (values.length === 0) return { max, bars: [] }
  const slot = box.width / values.length
  const width = Math.max(0, slot - box.gap)
  return {
    max,
    bars: values.map((v, i) => {
      const height = (v / max) * box.height
      return { x: i * slot + (slot - width) / 2, y: box.height - height, width, height }
    }),
  }
}
