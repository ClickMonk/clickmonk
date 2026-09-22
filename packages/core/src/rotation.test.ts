import { describe, expect, it } from 'vitest'
import { pickTarget } from './rotation.js'

const t = (id: string, weight: number) => ({ id, url: `https://example.com/${id}`, weight })

describe('pickTarget', () => {
  const targets = [t('a', 70), t('b', 20), t('c', 10)]

  it.each([
    [0, 'a'],
    [0.6999, 'a'],
    [0.7, 'b'],
    [0.8999, 'b'],
    [0.9, 'c'],
    [0.9999, 'c'],
  ])('random %f picks %s', (r, id) => {
    expect(pickTarget(targets, r).id).toBe(id)
  })

  it('returns the only target', () => {
    expect(pickTarget([t('solo', 100)], 0.5).id).toBe('solo')
  })

  it('never falls off the end for random just below 1', () => {
    expect(pickTarget(targets, 1 - Number.EPSILON).id).toBe('c')
  })
})
