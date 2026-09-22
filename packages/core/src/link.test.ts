import { describe, expect, it } from 'vitest'
import {
  LinkInputSchema,
  isDestinationUrl,
  isDomainUrl,
  normaliseHost,
  parseLinkInput,
} from './link.js'

const base = { slug: 'spring-sale', targets: [{ url: 'https://example.com/offer' }] }

describe('parseLinkInput', () => {
  it('accepts a minimal link and fills the defaults', () => {
    const l = parseLinkInput(base)
    expect(l.enabled).toBe(true)
    expect(l.passthrough).toBe(true)
    expect(l.countries).toEqual({ mode: 'all' })
    expect(l.trafficActions).toEqual({})
    expect(l.targets).toEqual([{ url: 'https://example.com/offer', weight: 100 }])
    expect(l.clickCap).toBeNull()
    expect(l.expiresAt).toBeNull()
  })

  it.each(['', '-lead', 'has space', 'a/b', 'x'.repeat(65), 'ünicode'])(
    'rejects slug %j',
    (slug) => {
      expect(() => parseLinkInput({ ...base, slug })).toThrow()
    },
  )

  it.each(['a', 'A1', 'spring_sale-2', 'x'.repeat(64)])('accepts slug %j', (slug) => {
    expect(parseLinkInput({ ...base, slug }).slug).toBe(slug)
  })

  it('requires weights that sum to 100 when there are several targets', () => {
    const two = (a: number, b: number) =>
      parseLinkInput({
        ...base,
        targets: [
          { url: 'https://example.com/a', weight: a },
          { url: 'https://example.com/b', weight: b },
        ],
      })
    expect(() => two(50, 40)).toThrow()
    expect(two(70, 30).targets.map((t) => t.weight)).toEqual([70, 30])
  })

  it('rejects an empty target list and more than 20 targets', () => {
    // Asserted on the issue, not on a throw: an empty list would also fail the
    // sum-to-100 check, so a bare toThrow() passes without the length bound.
    const empty = LinkInputSchema.safeParse({ ...base, targets: [] })
    expect(empty.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'too_small', path: ['targets'] }),
    )
    const many = Array.from({ length: 21 }, (_, i) => ({
      url: `https://example.com/${i}`,
      weight: 1,
    }))
    expect(() => parseLinkInput({ ...base, targets: many })).toThrow()
  })

  it('requires a country list for allow and block, in ISO alpha-2 upper case', () => {
    expect(() => parseLinkInput({ ...base, countries: { mode: 'allow', list: [] } })).toThrow()
    expect(() => parseLinkInput({ ...base, countries: { mode: 'block', list: ['usa'] } })).toThrow()
    expect(
      parseLinkInput({ ...base, countries: { mode: 'block', list: ['US', 'DE'] } }).countries,
    ).toEqual({ mode: 'block', list: ['US', 'DE'] })
  })

  it('bounds the click cap', () => {
    expect(() => parseLinkInput({ ...base, clickCap: 0 })).toThrow()
    expect(() => parseLinkInput({ ...base, clickCap: 1.5 })).toThrow()
    expect(parseLinkInput({ ...base, clickCap: 500 }).clickCap).toBe(500)
  })

  it('parses an ISO expiry into a Date', () => {
    const iso = new Date(Date.now() + 86_400_000).toISOString()
    expect(parseLinkInput({ ...base, expiresAt: iso }).expiresAt).toEqual(new Date(iso))
  })
})

describe('isDestinationUrl', () => {
  it.each([
    'https://example.com/a?sub={click_id}',
    'http://example.com/{param:sub1}',
    'https://example.com/?c={country}&d={device}&l={link}',
    'https://xn--bcher-kva.example/',
    'https://example.com/%E6%97%A5%E6%9C%AC?q=%C3%BC',
  ])('accepts %s', (u) => expect(isDestinationUrl(u)).toBe(true))

  it.each([
    'javascript:alert(1)',
    'ftp://example.com/',
    '//example.com/',
    'https://{param:host}/x',
    `https://example.com/${'a'.repeat(2048)}`,
    'not a url',
  ])('rejects %s', (u) => expect(isDestinationUrl(u)).toBe(false))

  // Each of these parses as a URL, but none can be sent as a Location header
  // as written: the parser drops a tab or newline, and a header carries no
  // character above U+007E intact.
  it.each([
    ['a newline', 'https://example.com/a\nb'],
    ['a carriage return', 'https://example.com/a\rb'],
    ['a tab', 'https://example.com/a\tb'],
    ['a space', 'https://example.com/a b'],
    ['a CJK path', 'https://example.com/日本'],
    ['a latin-1 path', 'https://example.com/café'],
    ['an internationalised host', 'https://bücher.example/'],
  ])('rejects a destination with %s', (_what, u) => {
    expect(() => new URL(u)).not.toThrow()
    expect(isDestinationUrl(u)).toBe(false)
  })
})

describe('isDomainUrl', () => {
  it('accepts a plain URL and rejects a token, which would be sent unrendered', () => {
    expect(isDomainUrl('https://example.com/home?x=%7B1%7D')).toBe(true)
    expect(isDomainUrl('https://example.com/?c={click_id}')).toBe(false)
    expect(isDomainUrl('https://example.com/?c={nope')).toBe(false)
    expect(isDomainUrl('https://example.com/日本')).toBe(false)
  })
})

describe('normaliseHost', () => {
  it('lower-cases and strips one trailing dot', () => {
    expect(normaliseHost('Go.Example.COM.')).toBe('go.example.com')
  })
  it.each(['', 'has space.com', 'a'.repeat(254), 'example.com:8080', '-bad.example.com'])(
    'rejects %j',
    (h) => expect(normaliseHost(h)).toBeNull(),
  )
})

describe('traffic action overrides', () => {
  it('takes any subset of the classes, and nothing else', () => {
    expect(parseLinkInput({ ...base, trafficActions: { bot: 'block' } }).trafficActions).toEqual({
      bot: 'block',
    })
    expect(() => parseLinkInput({ ...base, trafficActions: { human: 'block' } })).toThrow()
    expect(() => parseLinkInput({ ...base, trafficActions: { bot: 'drop' } })).toThrow()
  })
})
