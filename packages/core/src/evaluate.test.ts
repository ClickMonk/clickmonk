import { describe, expect, it } from 'vitest'
import { type EvalInput, evaluate, slugFromPath } from './evaluate.js'
import type { CountryRule, Domain, Link } from './link.js'
import { MAX_DESTINATION_LENGTH } from './passthrough.js'

const domain: Domain = {
  id: '00000000-0000-4000-8000-00000000000d',
  host: 'go.example.test',
  verified: true,
  rootUrl: null,
  notFoundUrl: null,
}

function link(over: Partial<Link> = {}): Link {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    domainId: domain.id,
    slug: 'spring',
    enabled: true,
    targets: [
      { id: '00000000-0000-4000-8000-0000000000f1', url: 'https://example.com/offer', weight: 100 },
    ],
    backupUrl: null,
    deviceUrls: {},
    returningUrl: null,
    countries: { mode: 'all' },
    clickCap: null,
    expiresAt: null,
    passthrough: true,
    trafficActions: {},
    ...over,
  }
}

function input(over: Partial<EvalInput> = {}, facts: Partial<EvalInput['facts']> = {}): EvalInput {
  return {
    domain,
    link: link(),
    capExhausted: false,
    ...over,
    facts: {
      path: '/spring',
      query: new URLSearchParams(),
      now: new Date(),
      device: 'desktop',
      country: 'DE',
      seenLink: false,
      clickId: '01920000-0000-7000-8000-000000000001',
      random: 0.5,
      ...facts,
    },
  }
}

const HOUR = 3_600_000

describe('resolve', () => {
  it('404s an unknown host', () => {
    expect(evaluate(input({ domain: null, link: null }))).toMatchObject({
      status: 404,
      outcome: 'unknown_domain',
      step: 'resolve',
      counted: false,
    })
  })

  it('treats an unverified domain as unknown', () => {
    expect(evaluate(input({ domain: { ...domain, verified: false } })).outcome).toBe(
      'unknown_domain',
    )
  })

  it('sends the root to the root URL, or 404s', () => {
    expect(evaluate(input({ link: null }, { path: '/' }))).toMatchObject({
      status: 404,
      outcome: 'root',
    })
    expect(
      evaluate(
        input(
          { domain: { ...domain, rootUrl: 'https://example.com/' }, link: null },
          { path: '/' },
        ),
      ),
    ).toMatchObject({ status: 302, location: 'https://example.com/', outcome: 'root' })
  })

  it('sends an unknown or disabled slug to the not-found URL, or 404s', () => {
    expect(evaluate(input({ link: null })).status).toBe(404)
    const d = { ...domain, notFoundUrl: 'https://example.com/404' }
    expect(evaluate(input({ domain: d, link: null }))).toMatchObject({
      status: 302,
      location: 'https://example.com/404',
      outcome: 'not_found',
    })
    expect(evaluate(input({ domain: d, link: link({ enabled: false }) })).outcome).toBe('not_found')
  })
})

describe('limits', () => {
  const past = () => new Date(Date.now() - HOUR)

  it('sends an expired link to its backup, or 410s', () => {
    expect(evaluate(input({ link: link({ expiresAt: past() }) }))).toMatchObject({
      status: 410,
      outcome: 'expired',
      step: 'limits',
      counted: false,
    })
    expect(
      evaluate(input({ link: link({ expiresAt: past(), backupUrl: 'https://example.com/b' }) })),
    ).toMatchObject({ status: 302, location: 'https://example.com/b', outcome: 'expired' })
  })

  it('treats the expiry instant itself as expired', () => {
    const now = new Date()
    expect(evaluate(input({ link: link({ expiresAt: now }) }, { now })).outcome).toBe('expired')
  })

  it('does not expire a link before its time', () => {
    expect(
      evaluate(input({ link: link({ expiresAt: new Date(Date.now() + HOUR) }) })).outcome,
    ).toBe('target')
  })

  it('sends a capped link to its backup, or 410s', () => {
    expect(evaluate(input({ capExhausted: true }))).toMatchObject({
      status: 410,
      outcome: 'capped',
    })
    expect(
      evaluate(input({ capExhausted: true, link: link({ backupUrl: 'https://example.com/b' }) })),
    ).toMatchObject({ status: 302, outcome: 'capped', counted: false })
  })
})

describe('country', () => {
  const allow = link({ countries: { mode: 'allow', list: ['DE', 'FR'] } })
  const block = link({ countries: { mode: 'block', list: ['DE'] } })

  it('allow-list: listed passes, unlisted and unknown are blocked', () => {
    expect(evaluate(input({ link: allow }, { country: 'FR' })).outcome).toBe('target')
    expect(evaluate(input({ link: allow }, { country: 'US' }))).toMatchObject({
      status: 403,
      outcome: 'country_blocked',
      step: 'country',
    })
    expect(evaluate(input({ link: allow }, { country: null })).outcome).toBe('country_blocked')
  })

  it('block-list: listed is blocked, unlisted and unknown pass', () => {
    expect(evaluate(input({ link: block }, { country: 'DE' })).outcome).toBe('country_blocked')
    expect(evaluate(input({ link: block }, { country: 'US' })).outcome).toBe('target')
    expect(evaluate(input({ link: block }, { country: null })).outcome).toBe('target')
  })

  it('sends a blocked country to the backup URL when there is one', () => {
    expect(
      evaluate(
        input({ link: { ...block, backupUrl: 'https://example.com/b' } }, { country: 'DE' }),
      ),
    ).toMatchObject({ status: 302, location: 'https://example.com/b', outcome: 'country_blocked' })
  })
})

describe('destination', () => {
  const full = link({
    deviceUrls: { android: 'https://example.com/android' },
    returningUrl: 'https://example.com/again',
  })

  it('returning beats device', () => {
    expect(evaluate(input({ link: full }, { seenLink: true, device: 'android' }))).toMatchObject({
      location: 'https://example.com/again',
      outcome: 'returning',
      counted: true,
    })
  })

  it('device beats rotation', () => {
    expect(evaluate(input({ link: full }, { device: 'android' }))).toMatchObject({
      location: 'https://example.com/android',
      outcome: 'device',
      counted: true,
    })
  })

  it('a device with no URL of its own falls through to the targets', () => {
    expect(evaluate(input({ link: full }, { device: 'ios' })).outcome).toBe('target')
  })

  it('rotation picks by weight and reports the target', () => {
    const rot = link({
      targets: [
        { id: '00000000-0000-4000-8000-0000000000f1', url: 'https://example.com/a', weight: 70 },
        { id: '00000000-0000-4000-8000-0000000000f2', url: 'https://example.com/b', weight: 30 },
      ],
    })
    expect(evaluate(input({ link: rot }, { random: 0.1 }))).toMatchObject({
      location: 'https://example.com/a',
      targetId: '00000000-0000-4000-8000-0000000000f1',
      counted: true,
    })
    expect(evaluate(input({ link: rot }, { random: 0.9 })).location).toBe('https://example.com/b')
  })

  it('renders tokens, then applies passthrough', () => {
    const l = link({
      targets: [{ id: 't', url: 'https://example.com/o?cid={click_id}&aff=1', weight: 100 }],
    })
    const d = evaluate(input({ link: l }, { query: new URLSearchParams('aff=2&utm_source=nl') }))
    expect(d.location).toBe(
      'https://example.com/o?cid=01920000-0000-7000-8000-000000000001&aff=1&utm_source=nl',
    )
  })

  it('skips passthrough when the link turns it off', () => {
    const d = evaluate(
      input({ link: link({ passthrough: false }) }, { query: new URLSearchParams('a=1') }),
    )
    expect(d.location).toBe('https://example.com/offer')
  })

  it('renders tokens and passthrough on the backup URL too', () => {
    const l = link({
      expiresAt: new Date(Date.now() - HOUR),
      backupUrl: 'https://example.com/b?c={click_id}',
    })
    const d = evaluate(input({ link: l }, { query: new URLSearchParams('s=1') }))
    expect(d.location).toBe('https://example.com/b?c=01920000-0000-7000-8000-000000000001&s=1')
  })

  it('empties an oversized {param:} value rather than build a destination past the bound', () => {
    const l = link({
      targets: [{ id: 't', url: 'https://example.com/o?s={param:s}&c={click_id}', weight: 100 }],
    })
    const d = evaluate(input({ link: l }, { query: new URLSearchParams({ s: 'x'.repeat(5000) }) }))
    expect(d.location).toBe('https://example.com/o?s=&c=01920000-0000-7000-8000-000000000001')
  })

  it('never builds a destination past the bound, whatever the tokens expand to', () => {
    const l = link({
      slug: 'x'.repeat(200),
      targets: [{ id: 't', url: `https://example.com/?${'{link}'.repeat(30)}`, weight: 100 }],
    })
    const d = evaluate(input({ link: l }))
    expect(d.location?.length).toBeLessThanOrEqual(MAX_DESTINATION_LENGTH)
    expect(d.location).toBe('https://example.com/?')
  })
})

describe('order', () => {
  const past = new Date(Date.now() - HOUR)
  const blockDE: CountryRule = { mode: 'block', list: ['DE'] }

  it('expiry is checked before the cap', () => {
    expect(evaluate(input({ capExhausted: true, link: link({ expiresAt: past }) })).outcome).toBe(
      'expired',
    )
  })

  it('limits are checked before country', () => {
    expect(evaluate(input({ link: link({ expiresAt: past, countries: blockDE }) })).outcome).toBe(
      'expired',
    )
    expect(
      evaluate(input({ capExhausted: true, link: link({ countries: blockDE }) })).outcome,
    ).toBe('capped')
  })

  it('country is checked before the destination', () => {
    const l = link({ countries: blockDE, returningUrl: 'https://example.com/again' })
    expect(evaluate(input({ link: l }, { seenLink: true })).outcome).toBe('country_blocked')
  })

  it('a disabled link is not found before it is expired', () => {
    expect(evaluate(input({ link: link({ enabled: false, expiresAt: past }) })).outcome).toBe(
      'not_found',
    )
  })

  it('every redirect that is not to a destination is uncounted', () => {
    for (const d of [
      evaluate(input({ link: null })),
      evaluate(input({ capExhausted: true })),
      evaluate(input({ link: link({ countries: blockDE }) })),
    ]) {
      expect(d.counted).toBe(false)
    }
  })
})

describe('slugFromPath', () => {
  it.each([
    ['/', ''],
    ['/spring', 'spring'],
    ['/a%2Db', 'a-b'],
    ['/a/b', null],
    ['/%E0%A4%A', null],
  ])('%s -> %j', (path, want) => {
    expect(slugFromPath(path)).toBe(want)
  })
})
