import type { CountryRule, Device, Domain, Link } from './link.js'
import { MAX_DESTINATION_LENGTH, applyPassthrough } from './passthrough.js'
import { pickTarget } from './rotation.js'
import type { TrafficSettings } from './settings.js'
import { type TokenContext, renderDestination } from './tokens.js'
import { type Traffic, type TrafficAction, actionFor, isNonHuman } from './traffic.js'

export type Outcome =
  | 'target'
  | 'device'
  | 'returning'
  | 'root'
  | 'not_found'
  | 'unknown_domain'
  | 'expired'
  | 'capped'
  | 'country_blocked'
  | 'blocked'
  | 'safe'

export type Step = 'resolve' | 'classify' | 'limits' | 'country' | 'destination'

export interface RequestFacts {
  /** Pathname only, starting with `/`. */
  path: string
  query: URLSearchParams
  now: Date
  device: Device
  /** ISO 3166-1 alpha-2, or null when unknown. */
  country: string | null
  /** This visitor has clicked this link before (the `cm_seen` cookie). */
  seenLink: boolean
  clickId: string
  /** In [0, 1); chooses the rotation target. */
  random: number
}

export interface EvalInput {
  facts: RequestFacts
  domain: Domain | null
  link: Link | null
  traffic: Traffic
  settings: TrafficSettings
  /** Set by the caller after the click-cap counter refused this click. */
  capExhausted: boolean
}

export interface Decision {
  status: 302 | 403 | 404 | 410
  location: string | null
  outcome: Outcome
  step: Step
  targetId: string | null
  /**
   * Consumes the click cap: a redirect to a destination, unless the click
   * was flagged or is a HEAD request.
   */
  counted: boolean
  /**
   * Sent to a destination, counted or not: marks the link seen for this
   * visitor. The caller checks a capped link's cap for every reached click,
   * consuming it when counted and only reading it otherwise, and evaluates
   * again with `capExhausted` when the cap is used up.
   */
  reached: boolean
  /**
   * The traffic action applied. Null for a click that stopped before
   * classification (resolve) and for a human or unknown one.
   */
  action: TrafficAction | null
}

/** `''` for the root, the decoded slug, or null when the path cannot be a slug. */
export function slugFromPath(path: string): string | null {
  if (path === '/') return ''
  const raw = path.slice(1)
  if (raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function stop(
  status: Decision['status'],
  location: string | null,
  outcome: Outcome,
  step: Step,
): Decision {
  return {
    status,
    location,
    outcome,
    step,
    targetId: null,
    counted: false,
    reached: false,
    action: null,
  }
}

const PARAM_TOKEN = /\{param:[A-Za-z0-9_.-]{1,64}\}/g
const ANY_TOKEN = /\{(?:click_id|country|device|link|param:[A-Za-z0-9_.-]{1,64})\}/g

/**
 * Renders tokens, then applies passthrough, and never returns more than
 * MAX_DESTINATION_LENGTH characters. A `{param:NAME}` value comes from the
 * request and has no length of its own, so past the bound the destination is
 * rendered again with those tokens empty: a destination missing a
 * visitor-supplied value is better than a click record too long to store.
 * Should even that exceed the bound, every token is emptied; the template
 * itself is at most 2048 characters.
 */
function build(template: string, link: Link, facts: RequestFacts): string {
  const ctx: TokenContext = {
    clickId: facts.clickId,
    country: facts.country,
    device: facts.device,
    slug: link.slug,
    query: facts.query,
  }
  let rendered = renderDestination(template, ctx)
  if (rendered.length > MAX_DESTINATION_LENGTH) {
    rendered = renderDestination(template.replace(PARAM_TOKEN, ''), ctx)
  }
  if (rendered.length > MAX_DESTINATION_LENGTH) rendered = template.replace(ANY_TOKEN, '')
  return link.passthrough ? applyPassthrough(rendered, facts.query) : rendered
}

function toBackup(
  link: Link,
  facts: RequestFacts,
  outcome: 'expired' | 'capped' | 'country_blocked',
  fallback: 403 | 410,
): Decision {
  const step: Step = outcome === 'country_blocked' ? 'country' : 'limits'
  if (!link.backupUrl) return stop(fallback, null, outcome, step)
  return stop(302, build(link.backupUrl, link, facts), outcome, step)
}

function countryAllowed(rule: CountryRule, country: string | null): boolean {
  if (rule.mode === 'all') return true
  if (rule.mode === 'allow') return country !== null && rule.list.includes(country)
  return country === null || !rule.list.includes(country)
}

/**
 * The redirect decision, as a pure function of the request and the link. The
 * order of the numbered steps below is part of the contract; a test pins
 * every pair of steps whose order matters.
 */
export function evaluate(input: EvalInput): Decision {
  const { facts, domain, link, traffic, settings } = input

  // 1. Resolve.
  if (!domain || !domain.verified) return stop(404, null, 'unknown_domain', 'resolve')
  if (facts.path === '/') {
    return domain.rootUrl
      ? stop(302, domain.rootUrl, 'root', 'resolve')
      : stop(404, null, 'root', 'resolve')
  }
  if (!link || !link.enabled) {
    return domain.notFoundUrl
      ? stop(302, domain.notFoundUrl, 'not_found', 'resolve')
      : stop(404, null, 'not_found', 'resolve')
  }

  // 2. Classify. The class's action, the link's override first. A HEAD
  // request that nothing else marks as non-human is ruled on as its GET
  // would be (no action) and recorded as bot with the action `nothing`.
  let action = actionFor(traffic.ruleClass, link.trafficActions, settings.actions)
  // A link can keep a safe override after the safe URL is removed; with
  // nowhere to send the click, it is flagged instead.
  if (action === 'safe' && settings.safeUrl === null) action = 'flag'
  const recorded: TrafficAction | null = action ?? (isNonHuman(traffic.class) ? 'nothing' : null)
  const decided = (d: Decision): Decision => ({ ...d, action: recorded })
  if (action === 'block') return decided(stop(403, null, 'blocked', 'classify'))
  if (action === 'safe') {
    return decided(stop(302, build(settings.safeUrl as string, link, facts), 'safe', 'classify'))
  }

  // 3. Limits. The expiry instant itself is expired.
  if (link.expiresAt && facts.now.getTime() >= link.expiresAt.getTime()) {
    return decided(toBackup(link, facts, 'expired', 410))
  }
  if (input.capExhausted) return decided(toBackup(link, facts, 'capped', 410))

  // 4. Password: not implemented yet.

  // 5. Country.
  if (!countryAllowed(link.countries, facts.country)) {
    return decided(toBackup(link, facts, 'country_blocked', 403))
  }

  // 6. Destination. A flagged click or a HEAD request is sent on but never
  // consumes the cap; an exhausted cap still stops it at step 3.
  const counted = action !== 'flag' && !traffic.signals.includes('head')
  const sent = (d: Decision): Decision => decided({ ...d, counted, reached: true })
  if (facts.seenLink && link.returningUrl) {
    return sent(stop(302, build(link.returningUrl, link, facts), 'returning', 'destination'))
  }
  const deviceUrl = link.deviceUrls[facts.device]
  if (deviceUrl) {
    return sent(stop(302, build(deviceUrl, link, facts), 'device', 'destination'))
  }
  const target = pickTarget(link.targets, facts.random)
  return sent({
    ...stop(302, build(target.url, link, facts), 'target', 'destination'),
    targetId: target.id,
  })
}
