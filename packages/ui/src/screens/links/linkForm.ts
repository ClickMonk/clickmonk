import type { Link, LinkInput, LinkPatch, NonHumanClass, TrafficAction } from '@/api/types'
import { NON_HUMAN_CLASSES } from '@/api/vocabulary'
import { zoneOffsetMinutes } from '@/window/range'

/**
 * A link as the form holds it, and the two requests that can be built from it.
 *
 * The state is strings wherever an input is: an empty string is a real value
 * that means "none", and a number is parsed only when a request is built. The
 * expiry is the local time a datetime-local input holds.
 *
 * An edit sends only what changed (the service re-validates the whole merged
 * link, so sending the whole form would be legal and wrong: it would carry
 * values the operator never touched, and a form that does not know the
 * password would send one it does not have). The password is never compared —
 * it is sent only when the operator chose to set or remove it.
 */

export interface LinkFormState {
  host: string
  slug: string
  name: string
  enabled: boolean
  targets: { url: string; weight: string }[]
  backupUrl: string
  deviceUrls: { ios: string; android: string; desktop: string }
  returningUrl: string
  countryMode: 'all' | 'allow' | 'block'
  countryList: string
  clickCap: string
  expiresAt: string
  passthrough: boolean
  trafficActions: Record<NonHumanClass, TrafficAction | 'inherit'>
  password: { mode: 'keep' | 'set' | 'remove'; value: string }
}

const INHERIT = {
  bot: 'inherit',
  abuser: 'inherit',
  anonymous: 'inherit',
  datacenter: 'inherit',
} as const

export function blankForm(host: string): LinkFormState {
  return {
    host,
    slug: '',
    name: '',
    enabled: true,
    targets: [{ url: '', weight: '100' }],
    backupUrl: '',
    deviceUrls: { ios: '', android: '', desktop: '' },
    returningUrl: '',
    countryMode: 'all',
    countryList: '',
    clickCap: '',
    expiresAt: '',
    passthrough: true,
    trafficActions: { ...INHERIT },
    password: { mode: 'keep', value: '' },
  }
}

const DAY = 86_400_000

/**
 * The instant a local time names in a zone.
 *
 * The zone's offset a day either side of the time gives two candidates, one
 * per offset in force around it (the same one twice on most days). A candidate
 * that reads back as the local time asked for is a real reading of it.
 *
 * - One matches on an ordinary day, and that is the answer.
 * - Both match on the morning the clocks go back, when the time happens twice:
 *   the earlier is taken, so the link expires the first time the clock shows it.
 * - Neither matches for a time the clocks skip (02:30 in Adelaide on the
 *   morning they go forward). The earlier candidate is read with the offset
 *   after the change, which puts it before the change by the length of the gap:
 *   the hour before, 01:30, which is what the round trip then shows. Lord Howe
 *   Island's clocks move by half an hour, so there it is half an hour before.
 *
 * Correcting a single guess until it settles does not work here: in a skipped
 * time the two offsets each point back at the other, and which one a fixed
 * number of rounds stops on depends on which side of UTC the zone is.
 */
export function localToInstant(local: string, timeZone: string): string {
  const [date = '', time = '00:00'] = local.split('T')
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const [h, mi] = time.split(':').map(Number) as [number, number]
  const wall = Date.UTC(y, m - 1, d, h, mi)
  const candidates = [
    wall - zoneOffsetMinutes(wall - DAY, timeZone) * 60_000,
    wall - zoneOffsetMinutes(wall + DAY, timeZone) * 60_000,
  ]
  const readings = candidates.filter((g) => g + zoneOffsetMinutes(g, timeZone) * 60_000 === wall)
  return new Date(Math.min(...(readings.length > 0 ? readings : candidates))).toISOString()
}

export function instantToLocal(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}`
}

export function formOf(l: Link, timeZone: string): LinkFormState {
  return {
    host: l.host,
    slug: l.slug,
    name: l.name ?? '',
    enabled: l.enabled,
    targets: l.targets.map((t) => ({ url: t.url, weight: String(t.weight) })),
    backupUrl: l.backupUrl ?? '',
    deviceUrls: {
      ios: l.deviceUrls.ios ?? '',
      android: l.deviceUrls.android ?? '',
      desktop: l.deviceUrls.desktop ?? '',
    },
    returningUrl: l.returningUrl ?? '',
    countryMode: l.countries.mode,
    countryList: l.countries.mode === 'all' ? '' : l.countries.list.join(', '),
    clickCap: l.clickCap === null ? '' : String(l.clickCap),
    expiresAt: l.expiresAt === null ? '' : instantToLocal(l.expiresAt, timeZone),
    passthrough: l.passthrough,
    trafficActions: { ...INHERIT, ...l.trafficActions },
    password: { mode: 'keep', value: '' },
  }
}

/** The codes a country list names, upper-cased, in the order typed. */
export const countryCodes = (list: string): string[] =>
  list
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)

/** Each part of a request, from the state. `undefined` means "not set". */
const parts = {
  name: (s: LinkFormState) => (s.name === '' ? null : s.name),
  enabled: (s: LinkFormState) => s.enabled,
  targets: (s: LinkFormState) =>
    s.targets.map((t) =>
      s.targets.length === 1 ? { url: t.url } : { url: t.url, weight: Number(t.weight) },
    ),
  backupUrl: (s: LinkFormState) => (s.backupUrl === '' ? null : s.backupUrl),
  deviceUrls: (s: LinkFormState) =>
    Object.fromEntries(
      Object.entries(s.deviceUrls).filter(([, v]) => v !== ''),
    ) as LinkInput['deviceUrls'],
  returningUrl: (s: LinkFormState) => (s.returningUrl === '' ? null : s.returningUrl),
  countries: (s: LinkFormState): LinkInput['countries'] =>
    s.countryMode === 'all'
      ? { mode: 'all' }
      : { mode: s.countryMode, list: countryCodes(s.countryList) },
  clickCap: (s: LinkFormState) => (s.clickCap === '' ? null : Number(s.clickCap)),
  expiresAt: (s: LinkFormState, tz: string) =>
    s.expiresAt === '' ? null : localToInstant(s.expiresAt, tz),
  passthrough: (s: LinkFormState) => s.passthrough,
  trafficActions: (s: LinkFormState) =>
    Object.fromEntries(
      NON_HUMAN_CLASSES.filter((c) => s.trafficActions[c] !== 'inherit').map((c) => [
        c,
        s.trafficActions[c],
      ]),
    ),
} as const

type Part = keyof typeof parts

/** The body of a create: every field that differs from a blank form's. */
export function inputOf(s: LinkFormState, timeZone: string): LinkInput {
  const blank = blankForm(s.host)
  const body: Record<string, unknown> = { host: s.host, targets: parts.targets(s) }
  if (s.slug !== '') body.slug = s.slug
  for (const k of Object.keys(parts) as Part[]) {
    if (k === 'targets') continue
    const value = parts[k](s, timeZone)
    if (JSON.stringify(value) !== JSON.stringify(parts[k](blank, timeZone))) body[k] = value
  }
  if (s.password.mode === 'set') body.password = s.password.value
  return body as unknown as LinkInput
}

/** The body of an edit: only the parts whose value changed. */
export function patchOf(before: LinkFormState, after: LinkFormState, timeZone: string): LinkPatch {
  const body: Record<string, unknown> = {}
  if (after.slug !== before.slug) body.slug = after.slug
  for (const k of Object.keys(parts) as Part[]) {
    const a = parts[k](after, timeZone)
    if (JSON.stringify(a) !== JSON.stringify(parts[k](before, timeZone))) body[k] = a
  }
  if (after.password.mode === 'set') body.password = after.password.value
  if (after.password.mode === 'remove') body.password = null
  return body as LinkPatch
}

const WHOLE = /^\d+$/

/** What the form refuses before building a request. Everything else is the service's to refuse. */
export function problemsOf(s: LinkFormState): Record<string, string> {
  const out: Record<string, string> = {}
  if (s.clickCap !== '' && (!WHOLE.test(s.clickCap) || Number(s.clickCap) < 1)) {
    out.clickCap = 'A click cap is a whole number of clicks, at least 1.'
  }
  if (s.targets.length > 1) {
    if (
      s.targets.some((t) => !WHOLE.test(t.weight) || Number(t.weight) < 1 || Number(t.weight) > 100)
    ) {
      out.targets = 'A weight is a whole number from 1 to 100.'
    } else {
      const sum = s.targets.reduce((n, t) => n + Number(t.weight), 0)
      if (sum !== 100) out.targets = `Weights add up to ${sum}; they must add up to 100.`
    }
  }
  if (s.countryMode !== 'all') {
    const list = countryCodes(s.countryList)
    const bad = list.find((c) => !/^[A-Z]{2}$/.test(c))
    if (list.length === 0) out.countries = 'Name at least one country.'
    else if (bad) out.countries = `“${bad}” is not a two-letter country code.`
  }
  if (s.password.mode === 'set' && s.password.value.length < 6) {
    out.password = 'A link password is at least 6 characters.'
  }
  return out
}

/**
 * The service's `invalid_link` message, field by field: `targets.1.url: text`
 * lands under `targets.1`, `backupUrl: text` under `backupUrl`, and a part with
 * no path under `form`.
 */
export function fieldErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of message.split('; ')) {
    const m = /^([A-Za-z]+(?:\.\d+)?)[.\w]*: (.*)$/.exec(part)
    // `link` and `body` are the service's names for a refusal of the whole
    // link or the whole body — weights that do not add up, a body it could not
    // read — and belong to the form, not to a field named after them.
    const key = m?.[1] && m[2] && m[1] !== 'link' && m[1] !== 'body' ? m[1] : 'form'
    const text = key === 'form' ? (m?.[2] ?? part) : (m?.[2] as string)
    out[key] = out[key] ? `${out[key]}; ${text}` : text
  }
  return out
}
