import { describe, expect, it } from 'vitest'
import {
  countryName,
  formatAge,
  formatDate,
  formatInstant,
  formatNumber,
  formatShare,
} from './format'

describe('numbers', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [12345, '12,345'],
    [1000000, '1,000,000'],
  ])('writes %i as %s', (n, text) => expect(formatNumber(n)).toBe(text))

  it.each([
    [42, 100, '42%'],
    [1, 3, '33%'],
    [1, 1000, '<1%'],
    [0, 10, '0%'],
    [0, 0, '–'],
    [10, 10, '100%'],
  ])('writes %i of %i as %s', (part, whole, text) => expect(formatShare(part, whole)).toBe(text))
})

describe('instants', () => {
  it('writes an instant in the zone it is given', () => {
    expect(formatInstant('2026-10-07T03:00:00.000Z', 'Australia/Adelaide')).toBe(
      '7 Oct 2026, 13:30',
    )
    expect(formatInstant('2026-10-07T03:00:00.000Z', 'UTC')).toBe('7 Oct 2026, 03:00')
  })

  it('writes a date in the zone it is given, which can be another day', () => {
    expect(formatDate('2026-10-06T20:00:00.000Z', 'Australia/Adelaide')).toBe('7 Oct 2026')
    expect(formatDate('2026-10-06T20:00:00.000Z', 'UTC')).toBe('6 Oct 2026')
  })

  it.each([
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [4 * 60_000, '4 minutes ago'],
    [3 * 3_600_000, '3 hours ago'],
    [2 * 86_400_000, '2 days ago'],
  ])('writes an age of %i ms as %s', (ms, text) => expect(formatAge(0, ms)).toBe(text))
})

describe('countries', () => {
  it('names a country by its code', () => expect(countryName('DE')).toBe('Germany'))
  it('keeps a code it cannot name', () => expect(countryName('XX')).toBe('XX'))
  it('says an empty code is unknown', () => expect(countryName('')).toBe('Unknown'))
})
