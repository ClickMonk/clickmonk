import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRAFFIC_ACTIONS,
  type IpFacts,
  LinkTrafficActionsSchema,
  NO_IP_FACTS,
  type TrafficFacts,
  actionFor,
  classifyTraffic,
} from './traffic.js'

const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const CRAWLER = 'Mozilla/5.0 (compatible; Googlebot/2.1)'
const CHECKED: IpFacts = {
  country: 'DE',
  asn: 64500,
  tor: false,
  datacenter: false,
  geoSource: 'x',
}

const facts = (over: Partial<TrafficFacts> = {}, ip: Partial<IpFacts> = {}): TrafficFacts => ({
  userAgent: BROWSER,
  head: false,
  clicksThisMinute: 1,
  abuserThreshold: 60,
  ...over,
  ip: { ...CHECKED, ...ip },
})

describe('classifyTraffic', () => {
  it('is human when every check ran and none fired', () => {
    expect(classifyTraffic(facts())).toEqual({ class: 'human', ruleClass: 'human', signals: [] })
  })

  it.each([
    ['a missing user-agent', facts({ userAgent: '' }), 'bot', ['ua_missing']],
    ['a crawler user-agent', facts({ userAgent: CRAWLER }), 'bot', ['ua_bot']],
    ['one click over the threshold', facts({ clicksThisMinute: 61 }), 'abuser', ['rate']],
    ['a Tor exit', facts({}, { tor: true }), 'anonymous', ['tor']],
    ['a hosting network', facts({}, { datacenter: true }), 'datacenter', ['datacenter']],
  ] as const)('classifies %s', (_label, f, cls, signals) => {
    expect(classifyTraffic(f)).toEqual({ class: cls, ruleClass: cls, signals })
  })

  it('does not call the threshold itself abuse', () => {
    expect(classifyTraffic(facts({ clicksThisMinute: 60 })).class).toBe('human')
  })

  it('takes the first class in order, and records every signal', () => {
    const all = facts({ userAgent: CRAWLER, clicksThisMinute: 99 }, { tor: true, datacenter: true })
    expect(classifyTraffic(all)).toEqual({
      class: 'bot',
      ruleClass: 'bot',
      signals: ['ua_bot', 'rate', 'tor', 'datacenter'],
    })
    expect(
      classifyTraffic(facts({ clicksThisMinute: 99 }, { tor: true, datacenter: true })).class,
    ).toBe('abuser')
    expect(classifyTraffic(facts({}, { tor: true, datacenter: true })).class).toBe('anonymous')
  })

  it('is unknown, not human, when the IP checks could not run', () => {
    expect(classifyTraffic({ ...facts(), ip: NO_IP_FACTS }).class).toBe('unknown')
    expect(classifyTraffic(facts({}, { tor: null })).class).toBe('unknown')
    expect(classifyTraffic(facts({}, { datacenter: null })).class).toBe('unknown')
  })

  it('still classifies by user-agent and rate without IP data', () => {
    expect(classifyTraffic({ ...facts({ userAgent: '' }), ip: NO_IP_FACTS }).class).toBe('bot')
    expect(classifyTraffic({ ...facts({ clicksThisMinute: 61 }), ip: NO_IP_FACTS }).class).toBe(
      'abuser',
    )
  })

  it('records a HEAD request as bot, but rules on it as the same GET', () => {
    expect(classifyTraffic(facts({ head: true }))).toEqual({
      class: 'bot',
      ruleClass: 'human',
      signals: ['head'],
    })
    expect(classifyTraffic({ ...facts({ head: true }), ip: NO_IP_FACTS })).toMatchObject({
      class: 'bot',
      ruleClass: 'unknown',
    })
  })

  it('leaves a HEAD request that is non-human for another reason in that class', () => {
    expect(classifyTraffic(facts({ head: true }, { datacenter: true }))).toEqual({
      class: 'datacenter',
      ruleClass: 'datacenter',
      signals: ['head', 'datacenter'],
    })
  })
})

describe('actionFor', () => {
  it('takes the link override, else the install-wide action', () => {
    expect(actionFor('bot', {}, DEFAULT_TRAFFIC_ACTIONS)).toBe('flag')
    expect(actionFor('bot', { bot: 'block' }, DEFAULT_TRAFFIC_ACTIONS)).toBe('block')
    expect(actionFor('abuser', { bot: 'block' }, DEFAULT_TRAFFIC_ACTIONS)).toBe('flag')
  })

  it('has no action for a human or unknown click', () => {
    const all = { bot: 'block', abuser: 'block', anonymous: 'block', datacenter: 'block' } as const
    expect(actionFor('human', all, all)).toBeNull()
    expect(actionFor('unknown', all, all)).toBeNull()
  })

  it('flags every class by default', () => {
    expect(Object.values(DEFAULT_TRAFFIC_ACTIONS)).toEqual(['flag', 'flag', 'flag', 'flag'])
  })
})

describe('LinkTrafficActionsSchema', () => {
  it('accepts any subset of the classes, and nothing else', () => {
    expect(LinkTrafficActionsSchema.parse({})).toEqual({})
    expect(LinkTrafficActionsSchema.parse({ bot: 'block' })).toEqual({ bot: 'block' })
    expect(LinkTrafficActionsSchema.safeParse({ human: 'block' }).success).toBe(false)
    expect(LinkTrafficActionsSchema.safeParse({ bot: 'drop' }).success).toBe(false)
  })
})
