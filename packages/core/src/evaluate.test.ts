import { describe, expect, it } from 'vitest'
import { type Decision, type EvalInput, evaluate, slugFromPath } from './evaluate.js'
import type { CountryRule, Domain, Link } from './link.js'
import { MAX_DESTINATION_LENGTH } from './passthrough.js'
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficSettings } from './settings.js'
import type { Traffic } from './traffic.js'

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
    passwordHash: null,
    trafficActions: {},
    ...over,
  }
}

const HUMAN: Traffic = { class: 'human', ruleClass: 'human', signals: [] }
const traffic = (cls: Traffic['class'], signals: Traffic['signals'] = []): Traffic => ({
  class: cls,
  ruleClass: cls,
  signals,
})
/** A HEAD request that nothing else marks as non-human, as classifyTraffic returns it. */
const HEAD: Traffic = { class: 'bot', ruleClass: 'human', signals: ['head'] }
const settings = (
  over: Partial<TrafficSettings['actions']> = {},
  safeUrl: string | null = null,
) => ({
  ...DEFAULT_TRAFFIC_SETTINGS,
  actions: { ...DEFAULT_TRAFFIC_SETTINGS.actions, ...over },
  safeUrl,
})

function input(over: Partial<EvalInput> = {}, facts: Partial<EvalInput['facts']> = {}): EvalInput {
  return {
    domain,
    link: link(),
    traffic: HUMAN,
    settings: DEFAULT_TRAFFIC_SETTINGS,
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
      passwordOk: false,
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

describe('classify', () => {
  it('blocks a class set to block, with 403 and no destination', () => {
    expect(
      evaluate(
        input({ traffic: traffic('bot', ['ua_bot']), settings: settings({ bot: 'block' }) }),
      ),
    ).toMatchObject({
      status: 403,
      location: null,
      outcome: 'blocked',
      step: 'classify',
      action: 'block',
      counted: false,
      reached: false,
    })
  })

  it('sends a class set to safe to the safe URL, tokens and passthrough applied', () => {
    const d = evaluate(
      input(
        {
          traffic: traffic('datacenter', ['datacenter']),
          settings: settings({ datacenter: 'safe' }, 'https://example.com/safe?c={click_id}'),
        },
        { query: new URLSearchParams('s=1') },
      ),
    )
    expect(d).toMatchObject({
      status: 302,
      location: 'https://example.com/safe?c=01920000-0000-7000-8000-000000000001&s=1',
      outcome: 'safe',
      step: 'classify',
      action: 'safe',
      counted: false,
      reached: false,
    })
  })

  it('flags instead when the safe action has no safe URL', () => {
    const l = link({ trafficActions: { datacenter: 'safe' } })
    expect(
      evaluate(input({ link: l, traffic: traffic('datacenter', ['datacenter']) })),
    ).toMatchObject({
      outcome: 'target',
      action: 'flag',
      counted: false,
    })
  })

  it("takes the link's override over the install-wide action", () => {
    const l = link({ trafficActions: { bot: 'nothing' } })
    const d = evaluate(
      input({ link: l, traffic: traffic('bot', ['ua_bot']), settings: settings({ bot: 'block' }) }),
    )
    expect(d).toMatchObject({ outcome: 'target', action: 'nothing', counted: true })
  })

  it('sends a flagged click on, marks the link seen, and does not count it', () => {
    expect(evaluate(input({ traffic: traffic('abuser', ['rate']) }))).toMatchObject({
      status: 302,
      outcome: 'target',
      action: 'flag',
      counted: false,
      reached: true,
    })
  })

  it('counts a click whose class is set to nothing', () => {
    expect(
      evaluate(
        input({
          traffic: traffic('anonymous', ['tor']),
          settings: settings({ anonymous: 'nothing' }),
        }),
      ),
    ).toMatchObject({ outcome: 'target', action: 'nothing', counted: true, reached: true })
  })

  it('applies no action to a human or unknown click, and counts it', () => {
    const all = settings({ bot: 'block', abuser: 'block', anonymous: 'block', datacenter: 'block' })
    for (const t of [HUMAN, traffic('unknown')]) {
      expect(evaluate(input({ traffic: t, settings: all }))).toMatchObject({
        outcome: 'target',
        action: null,
        counted: true,
        reached: true,
      })
    }
  })

  it('answers a HEAD request as the same GET, records the action nothing, and never counts it', () => {
    const d = evaluate(input({ traffic: HEAD, settings: settings({ bot: 'block' }) }))
    expect(d).toMatchObject({
      status: 302,
      outcome: 'target',
      action: 'nothing',
      counted: false,
      reached: true,
    })
  })

  it('does not count a HEAD request even when its class is set to nothing', () => {
    const t: Traffic = {
      class: 'datacenter',
      ruleClass: 'datacenter',
      signals: ['head', 'datacenter'],
    }
    expect(
      evaluate(input({ traffic: t, settings: settings({ datacenter: 'nothing' }) })),
    ).toMatchObject({
      outcome: 'target',
      counted: false,
    })
  })

  it('blocks a HEAD request when the same GET would be blocked', () => {
    const t: Traffic = {
      class: 'datacenter',
      ruleClass: 'datacenter',
      signals: ['head', 'datacenter'],
    }
    expect(
      evaluate(input({ traffic: t, settings: settings({ datacenter: 'block' }) })).outcome,
    ).toBe('blocked')
  })

  it('sends a flagged click and a HEAD request past an exhausted cap to the backup, or 410', () => {
    // Neither consumes the cap, but a reached cap closes the link to them too.
    const withBackup = link({ clickCap: 1, backupUrl: 'https://example.com/backup' })
    for (const t of [traffic('bot', ['ua_bot']), HEAD]) {
      expect(evaluate(input({ link: withBackup, traffic: t, capExhausted: true }))).toMatchObject({
        status: 302,
        location: 'https://example.com/backup',
        outcome: 'capped',
        counted: false,
        reached: false,
      })
      expect(
        evaluate(input({ link: link({ clickCap: 1 }), traffic: t, capExhausted: true })),
      ).toMatchObject({ status: 410, outcome: 'capped' })
    }
  })

  it('records no action for a click that stopped at resolve', () => {
    expect(evaluate(input({ link: null, traffic: traffic('bot', ['ua_bot']) })).action).toBeNull()
  })
})

describe('classify, in order', () => {
  const past = new Date(Date.now() - HOUR)
  const blockBot = { traffic: traffic('bot', ['ua_bot']), settings: settings({ bot: 'block' }) }

  it('resolves before it classifies', () => {
    expect(evaluate(input({ ...blockBot, link: null })).outcome).toBe('not_found')
    expect(evaluate(input({ ...blockBot, link: link({ enabled: false }) })).outcome).toBe(
      'not_found',
    )
  })

  it('classifies before the limits and the country', () => {
    expect(evaluate(input({ ...blockBot, link: link({ expiresAt: past }) })).outcome).toBe(
      'blocked',
    )
    expect(evaluate(input({ ...blockBot, capExhausted: true })).outcome).toBe('blocked')
    expect(
      evaluate(input({ ...blockBot, link: link({ countries: { mode: 'block', list: ['DE'] } }) }))
        .outcome,
    ).toBe('blocked')
  })

  it('classifies before it sends a returning visitor to the returning URL', () => {
    const returning = link({ returningUrl: 'https://example.com/again' })
    const seen = { seenLink: true }
    expect(evaluate(input({ ...blockBot, link: returning }, seen)).outcome).toBe('blocked')
    const safeBot = {
      traffic: traffic('bot', ['ua_bot']),
      settings: settings({ bot: 'safe' }, 'https://example.com/safe'),
    }
    expect(evaluate(input({ ...safeBot, link: returning }, seen))).toMatchObject({
      outcome: 'safe',
      location: 'https://example.com/safe',
    })
  })

  it('carries the action through the steps after it', () => {
    const flagged = { traffic: traffic('bot', ['ua_bot']) }
    expect(evaluate(input({ ...flagged, link: link({ expiresAt: past }) }))).toMatchObject({
      outcome: 'expired',
      action: 'flag',
    })
    expect(
      evaluate(input({ ...flagged, link: link({ countries: { mode: 'allow', list: ['FR'] } }) })),
    ).toMatchObject({ outcome: 'country_blocked', action: 'flag' })
  })
})

describe('password', () => {
  // The evaluator only asks whether there IS a hash, never what it is, so this
  // is deliberately not hash-shaped: no hash literal is committed anywhere in
  // the tree.
  const locked = link({ passwordHash: 'no-verifier-accepts-this' })
  /**
   * Every field of a Decision, so every assertion below is over the whole
   * decision: a step that fires in the wrong order changes the outcome, the
   * step, the status, the destination and the action together, and a partial
   * assertion would let some of that through.
   */
  const decision = (over: Partial<Decision> = {}): Decision => ({
    status: 302,
    location: null,
    outcome: 'target',
    step: 'destination',
    targetId: null,
    counted: false,
    reached: false,
    action: null,
    ...over,
  })
  const PAGE = decision({ status: 200, outcome: 'password', step: 'password' })
  const SENT = decision({
    location: 'https://example.com/offer',
    targetId: '00000000-0000-4000-8000-0000000000f1',
    reached: true,
    counted: true,
  })

  it('shows the page for a link with a password and no proof', () => {
    expect(evaluate(input({ link: locked }, { passwordOk: false }))).toEqual(PAGE)
  })

  it('sends the visitor on once the proof is there', () => {
    expect(evaluate(input({ link: locked }, { passwordOk: true }))).toEqual(SENT)
  })

  it('does not ask a link that has no password', () => {
    expect(evaluate(input({}, { passwordOk: false }))).toEqual(SENT)
  })

  // The order that matters: classify, then limits, then password, then country.
  it('is asked after classification, so a blocked click never sees the page', () => {
    expect(
      evaluate(
        input(
          { link: locked, traffic: traffic('bot'), settings: settings({ bot: 'block' }) },
          { passwordOk: false },
        ),
      ),
    ).toEqual(decision({ status: 403, outcome: 'blocked', step: 'classify', action: 'block' }))
  })

  it('is asked after the safe action, so flagged traffic is diverted rather than prompted', () => {
    expect(
      evaluate(
        input(
          {
            link: locked,
            traffic: traffic('datacenter'),
            settings: settings({ datacenter: 'safe' }, 'https://example.com/safe'),
          },
          { passwordOk: false },
        ),
      ),
    ).toEqual(
      decision({
        location: 'https://example.com/safe',
        outcome: 'safe',
        step: 'classify',
        action: 'safe',
      }),
    )
  })

  it('is asked after expiry and the cap, so a dead link does not collect a password', () => {
    const expired = link({
      passwordHash: locked.passwordHash,
      expiresAt: new Date(Date.now() - HOUR),
      backupUrl: 'https://example.com/backup',
    })
    expect(evaluate(input({ link: expired }, { passwordOk: false }))).toEqual(
      decision({ location: 'https://example.com/backup', outcome: 'expired', step: 'limits' }),
    )
    const capped = link({ passwordHash: locked.passwordHash, clickCap: 1 })
    expect(evaluate(input({ link: capped, capExhausted: true }, { passwordOk: false }))).toEqual(
      decision({ status: 410, outcome: 'capped', step: 'limits' }),
    )
  })

  it('is asked before the country rule, so the page does not say who may follow the link', () => {
    const geoLocked = link({
      passwordHash: locked.passwordHash,
      countries: { mode: 'allow', list: ['FR'] },
    })
    expect(evaluate(input({ link: geoLocked }, { passwordOk: false, country: 'DE' }))).toEqual(PAGE)
  })

  it('records the action of a flagged click that is prompted', () => {
    expect(
      evaluate(input({ link: locked, traffic: traffic('bot') }, { passwordOk: false })),
    ).toEqual(decision({ status: 200, outcome: 'password', step: 'password', action: 'flag' }))
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
