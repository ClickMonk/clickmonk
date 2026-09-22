import { z } from 'zod'
import { isBotUserAgent } from './user-agent.js'

/**
 * Traffic classes, in the order they are checked: a click carrying signals
 * of several classes takes the first. `human` means every check ran and
 * none fired. `unknown` means none fired but the IP checks could not run,
 * because the IP data is not loaded: the click is routed like a human one,
 * but it is not reported as one.
 */
export const NON_HUMAN_CLASSES = ['bot', 'abuser', 'anonymous', 'datacenter'] as const
export type NonHumanClass = (typeof NON_HUMAN_CLASSES)[number]
export const TRAFFIC_CLASSES = [...NON_HUMAN_CLASSES, 'human', 'unknown'] as const
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number]

/**
 * What happens to a click of a non-human class. `nothing` and `flag` both
 * send it on; a flagged click is marked in reports and never consumes a
 * click cap. `block` answers 403. `safe` sends it to the install-wide safe
 * URL instead of the link's destination.
 */
export const TRAFFIC_ACTIONS = ['nothing', 'flag', 'block', 'safe'] as const
export type TrafficAction = (typeof TRAFFIC_ACTIONS)[number]
export type TrafficActions = Record<NonHumanClass, TrafficAction>
/** A link's overrides: a class it does not name takes the install-wide action. */
export type LinkTrafficActions = Partial<TrafficActions>

const Action = z.enum(TRAFFIC_ACTIONS)

export const TrafficActionsSchema = z
  .object({ bot: Action, abuser: Action, anonymous: Action, datacenter: Action })
  .strict()

/** A link's overrides: any subset of the classes. */
export const LinkTrafficActionsSchema = TrafficActionsSchema.partial()

/** Flag, never block: a new install must not turn away real traffic because a list was wrong. */
export const DEFAULT_TRAFFIC_ACTIONS: TrafficActions = {
  bot: 'flag',
  abuser: 'flag',
  anonymous: 'flag',
  datacenter: 'flag',
}

/**
 * Every signal that fired is recorded, not only the one that decided the
 * class. `head` marks a HEAD request: link checkers and preview bots send
 * them, so one is recorded as bot, answered as its GET would be, and never
 * counted.
 */
export type Signal = 'ua_missing' | 'ua_bot' | 'head' | 'rate' | 'tor' | 'datacenter'

const SIGNAL_CLASS: Record<Exclude<Signal, 'head'>, NonHumanClass> = {
  ua_missing: 'bot',
  ua_bot: 'bot',
  rate: 'abuser',
  tor: 'anonymous',
  datacenter: 'datacenter',
}

/**
 * What the install's IP data says about an address. Each field is null when
 * the table that answers it is not loaded: `tor: false` means "checked, not
 * a Tor exit", `tor: null` means "not checked".
 */
export interface IpFacts {
  /** ISO 3166-1 alpha-2. */
  country: string | null
  asn: number | null
  tor: boolean | null
  datacenter: boolean | null
  /** Which country database answered, and its version; '' when none did. */
  geoSource: string
}

/** No IP data at all. Shared and returned by every lookup that finds nothing loaded; frozen so no caller can mutate the one instance for every other. */
export const NO_IP_FACTS: IpFacts = Object.freeze({
  country: null,
  asn: null,
  tor: null,
  datacenter: null,
  geoSource: '',
})

export interface TrafficFacts {
  /** Already cut to the bounded length the redirect records. */
  userAgent: string
  head: boolean
  /** Requests from this address in the current minute, this one included. */
  clicksThisMinute: number
  /** More than this many in a minute is an abuser. */
  abuserThreshold: number
  ip: IpFacts
}

export interface Traffic {
  /** The class recorded and reported. */
  class: TrafficClass
  /**
   * The class whose action the rules apply. The same as `class`, except for
   * a HEAD request that nothing else marks as non-human: that one is
   * recorded as bot but answered as the same GET would be.
   */
  ruleClass: TrafficClass
  signals: Signal[]
}

export function isNonHuman(c: TrafficClass): c is NonHumanClass {
  return c !== 'human' && c !== 'unknown'
}

/** Pure: the address's request count and IP facts are looked up by the caller. */
export function classifyTraffic(f: TrafficFacts): Traffic {
  const signals: Signal[] = []
  if (f.userAgent.length === 0) signals.push('ua_missing')
  else if (isBotUserAgent(f.userAgent)) signals.push('ua_bot')
  if (f.head) signals.push('head')
  if (f.clicksThisMinute > f.abuserThreshold) signals.push('rate')
  if (f.ip.tor === true) signals.push('tor')
  if (f.ip.datacenter === true) signals.push('datacenter')

  let ruleClass: TrafficClass = f.ip.tor === null || f.ip.datacenter === null ? 'unknown' : 'human'
  for (const c of NON_HUMAN_CLASSES) {
    if (signals.some((s) => s !== 'head' && SIGNAL_CLASS[s] === c)) {
      ruleClass = c
      break
    }
  }
  const cls: TrafficClass = f.head && !isNonHuman(ruleClass) ? 'bot' : ruleClass
  return { class: cls, ruleClass, signals }
}

/** The link's override for this class, else the install's; null for a human or unknown click. */
export function actionFor(
  ruleClass: TrafficClass,
  link: LinkTrafficActions,
  install: TrafficActions,
): TrafficAction | null {
  if (!isNonHuman(ruleClass)) return null
  return link[ruleClass] ?? install[ruleClass]
}
