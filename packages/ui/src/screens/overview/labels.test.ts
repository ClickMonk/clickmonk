import { describe, expect, it } from 'vitest'
import { ZERO_LINK, rowLabel } from './labels'

const row = (value: string, extra: object = {}) => ({ value, clicks: 1, visitors: 1, ...extra })

describe('what a breakdown row is called', () => {
  it.each([
    ['country', 'DE', 'Germany'],
    ['country', '', 'Unknown'],
    ['device', 'ios', 'iOS'],
    ['device', 'desktop', 'Desktop'],
    ['os', 'windows', 'windows'],
    ['os', '', 'Unknown'],
    ['browser', '', 'Unknown'],
    ['referrer', 'blog.example.com', 'blog.example.com'],
    ['referrer', '', 'No referrer'],
    ['class', 'datacenter', 'Datacenter'],
    ['action', 'flag', 'Flagged'],
    ['action', '', 'None (human or unknown)'],
    ['outcome', 'country_blocked', 'Country not allowed'],
  ] as const)('%s %j is %s', (dimension, value, label) => {
    expect(rowLabel(dimension, row(value), {})).toBe(label)
  })

  it('names a link by where it lives, and its name when it has one', () => {
    expect(
      rowLabel(
        'link',
        row('a1', { link: { slug: 'spring', host: 'go.example.test', name: 'Spring offer' } }),
        {},
      ),
    ).toBe('go.example.test/spring — Spring offer')
    expect(
      rowLabel(
        'link',
        row('a2', { link: { slug: 'autumn', host: 'go.example.test', name: null } }),
        {},
      ),
    ).toBe('go.example.test/autumn')
  })

  it('says a link was deleted, and says what the zero link is', () => {
    expect(rowLabel('link', row('a3', { link: null }), {})).toBe('A deleted link')
    expect(rowLabel('link', row(ZERO_LINK, { link: null }), {})).toBe(
      'No link (unknown slugs and domain roots)',
    )
  })

  it('names a target by its URL, and says when there was none', () => {
    const targets = new Map([['t1', 'https://example.com/offer']])
    expect(rowLabel('target', row('t1'), { targets })).toBe('https://example.com/offer')
    expect(rowLabel('target', row(''), { targets })).toBe('No target (turned away)')
    expect(rowLabel('target', row('t9'), { targets })).toBe('A target since removed')
  })
})
