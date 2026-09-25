import { describe, expect, it } from 'vitest'
import { columns, niceMax } from './columns'

describe('the axis maximum', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 5],
    [7, 10],
    [37, 50],
    [100, 100],
    [101, 200],
    [4999, 5000],
    [5001, 10000],
  ])('for a largest value of %i is %i', (v, max) => expect(niceMax(v)).toBe(max))
})

describe('columns', () => {
  const box = { width: 100, height: 50, gap: 2 }

  it('draws one column per bucket, a zero as a column of no height on the baseline', () => {
    const r = columns([10, 0, 5], box)
    expect(r.max).toBe(10)
    // Three slots of 33.33 wide, each column 2 narrower than its slot.
    expect(r.bars.map((b) => [round(b.x), round(b.width), round(b.y), round(b.height)])).toEqual([
      [1, 31.33, 0, 50],
      [34.33, 31.33, 50, 0],
      [67.67, 31.33, 25, 25],
    ])
  })

  it('draws an all-zero chart as zero columns under an axis of one', () => {
    const r = columns([0, 0], box)
    expect(r.max).toBe(1)
    expect(r.bars.map((b) => b.height)).toEqual([0, 0])
  })

  it('draws nothing for no buckets', () => {
    expect(columns([], box)).toEqual({ max: 1, bars: [] })
  })

  it('never draws a column narrower than nothing when the gap is wider than a slot', () => {
    const r = columns(new Array(100).fill(1), { width: 100, height: 10, gap: 2 })
    expect(Math.min(...r.bars.map((b) => b.width))).toBe(0)
  })
})

const round = (n: number) => Math.round(n * 100) / 100
