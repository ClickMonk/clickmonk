import { describe, expect, it } from 'vitest'
import { applyPassthrough } from './passthrough.js'

describe('applyPassthrough', () => {
  it('appends incoming parameters', () => {
    expect(applyPassthrough('https://example.com/a', new URLSearchParams('utm_source=x&b=2'))).toBe(
      'https://example.com/a?utm_source=x&b=2',
    )
  })

  it('appends with & when the destination already has a query', () => {
    expect(applyPassthrough('https://example.com/a?aff=1', new URLSearchParams('b=2'))).toBe(
      'https://example.com/a?aff=1&b=2',
    )
  })

  it('never overwrites a parameter the destination already sets', () => {
    expect(
      applyPassthrough('https://example.com/a?aff=mine', new URLSearchParams('aff=theirs&b=2')),
    ).toBe('https://example.com/a?aff=mine&b=2')
  })

  it('keeps the fragment at the end', () => {
    expect(applyPassthrough('https://example.com/a#top', new URLSearchParams('b=2'))).toBe(
      'https://example.com/a?b=2#top',
    )
  })

  it('uses at most 50 incoming parameters', () => {
    const q = new URLSearchParams(
      Array.from({ length: 60 }, (_, i): [string, string] => [`p${i}`, '1']),
    )
    const out = new URL(applyPassthrough('https://example.com/', q))
    expect([...out.searchParams.keys()]).toHaveLength(50)
  })

  it('stops adding parameters before the URL passes the length bound', () => {
    const q = new URLSearchParams({ a: 'x'.repeat(3000), b: 'y'.repeat(3000) })
    const out = applyPassthrough('https://example.com/', q, 4096)
    expect(out.length).toBeLessThanOrEqual(4096)
    expect(new URL(out).searchParams.get('a')).toHaveLength(3000)
    expect(new URL(out).searchParams.has('b')).toBe(false)
  })

  it('returns the destination unchanged when there is nothing to add', () => {
    expect(applyPassthrough('https://example.com/a?x=1', new URLSearchParams())).toBe(
      'https://example.com/a?x=1',
    )
  })
})
