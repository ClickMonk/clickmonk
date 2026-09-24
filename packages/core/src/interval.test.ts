import { describe, expect, it } from 'vitest'
import { MAX_TIMER_MS, checkIntervalMs } from './interval.js'

/**
 * The numbers here are written out rather than derived from `MAX_TIMER_MS`: a
 * bound computed from the constant it is testing accepts whatever that constant
 * becomes. What is asserted about the constant itself is the one fact that makes
 * it the right number — it is the largest signed 32-bit integer, which is what
 * `setTimeout` holds a delay in.
 */
describe('checkIntervalMs', () => {
  it('is the largest delay a timer holds', () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1)
  })

  it('takes a whole number of milliseconds inside the range', () => {
    expect(checkIntervalMs('intervalMs', 1)).toBe(1)
    expect(checkIntervalMs('intervalMs', 3_600_000)).toBe(3_600_000)
    expect(checkIntervalMs('intervalMs', 2147483647)).toBe(2147483647)
  })

  // 2,147,483,648 first, because it is the one that arrives by accident: it is a
  // little under twenty-five days, which is what someone asking for a monthly
  // pass types, and `setTimeout` answers it with a delay of 1 ms rather than an
  // error.
  it.each([2147483648, 2_592_000_000, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %p, naming the thing that is wrong',
    (ms) => {
      expect(() => checkIntervalMs('intervalMs', ms)).toThrow(/intervalMs/)
    },
  )
})
