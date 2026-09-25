/**
 * A time window, in the operator's own days.
 *
 * Reports are counted in UTC by the hour, and the service has no time zone of
 * its own. So "today" is the browser's today: this module turns a preset or two
 * local dates into two UTC instants, chooses whether to chart them by the hour
 * or by the day, and says where a day chart's days begin — which is not always
 * local midnight, because a day can only begin on a whole hour of UTC and some
 * zones are not a whole number of hours from it, and because a window can cross
 * a clock change.
 *
 * Every function takes the zone as a parameter and nothing here reads the
 * browser's own; `useWindow` does, once.
 */

export const PRESETS = ['today', 'yesterday', '7d', '30d', '90d', '12m'] as const
export type PresetId = (typeof PRESETS)[number]

export const PRESET_LABELS: Record<PresetId, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
}

/** What the operator asked for: a preset, or two local calendar dates, both included. */
export type Choice = { preset: PresetId } | { from: string; to: string }

export const DEFAULT_CHOICE: Choice = { preset: '7d' }

/** Two UTC instants, half-open. */
export interface Span {
  fromMs: number
  toMs: number
}

const HOUR = 3_600_000
const DAY = 86_400_000

/** Charted by the hour up to three days: 72 bars. */
export const HOURLY_UP_TO_MS = 3 * DAY

/**
 * The longest custom range, in local days. Not the service's 400: the service
 * measures a window after aligning it to whole days, which can add up to a day
 * at each end, and a clock change adds an hour. 366 cannot reach 400 either way.
 */
export const MAX_CUSTOM_DAYS = 366

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Minutes the zone is ahead of UTC at an instant: 570 for Adelaide in winter. */
export function zoneOffsetMinutes(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs))
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  const whole = atMs - (((atMs % 1000) + 1000) % 1000)
  return Math.round((wall - whole) / 60_000)
}

/** The local calendar date of an instant, as `YYYY-MM-DD`. */
export function localDate(atMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(atMs))
  const v = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${v('year')}-${v('month')}-${v('day')}`
}

/**
 * The instant a local calendar date begins: its first instant, which is
 * midnight on most days and the moment the clocks change on a day whose
 * midnight is skipped (Havana, Santiago, Cairo, Beirut and the Azores move
 * their clocks at midnight, so those days begin at 01:00).
 *
 * The first guess reads the zone's offset at midnight read as UTC, and each
 * correction re-reads it at the previous guess. Most days settle at once. On a
 * skipped midnight they never do: the two offsets either side of the change
 * each point back at the other, so the guesses alternate for ever, and which
 * one a fixed number of rounds stops on depends on the zone. Of the two, only
 * the one at the moment of the change falls on the date; the other is still
 * the day before. So the answer is the candidate whose local date is the date
 * asked for.
 *
 * A date the zone skipped entirely (Samoa went from 29 to 31 December 2011)
 * has no instant of its own, and neither candidate falls on it. It begins
 * where the next day does, and so lasts no time at all.
 */
export function startOfDate(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const wall = Date.UTC(y, m - 1, d)
  const g0 = wall - zoneOffsetMinutes(wall, timeZone) * 60_000
  const g1 = wall - zoneOffsetMinutes(g0, timeZone) * 60_000
  const g2 = wall - zoneOffsetMinutes(g1, timeZone) * 60_000
  return (
    [g1, g2].find((g) => localDate(g, timeZone) === date) ?? startOfDate(addDays(date, 1), timeZone)
  )
}

/** A calendar date moved by whole days. Calendar arithmetic, so no zone is involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function spanOf(choice: Choice, nowMs: number, timeZone: string): Span {
  if ('from' in choice) {
    return {
      fromMs: startOfDate(choice.from, timeZone),
      toMs: startOfDate(addDays(choice.to, 1), timeZone),
    }
  }
  const today = localDate(nowMs, timeZone)
  const since = (daysBack: number): Span => ({
    fromMs: startOfDate(addDays(today, -daysBack), timeZone),
    toMs: nowMs,
  })
  switch (choice.preset) {
    case 'today':
      return since(0)
    case 'yesterday':
      return {
        fromMs: startOfDate(addDays(today, -1), timeZone),
        toMs: startOfDate(today, timeZone),
      }
    case '7d':
      return since(6)
    case '30d':
      return since(29)
    case '90d':
      return since(89)
    case '12m':
      return since(364)
  }
}

export function bucketFor(span: Span): 'hour' | 'day' {
  return span.toMs - span.fromMs <= HOURLY_UP_TO_MS ? 'hour' : 'day'
}

/**
 * Where a day chart's days begin, in whole hours from UTC: the zone's offset
 * where the window begins, rounded half up. Every zone in use lands inside the
 * service's −12 to +14, so nothing is clamped.
 */
export function dayOffsetHours(span: Span, timeZone: string): number {
  return Math.round(zoneOffsetMinutes(span.fromMs, timeZone) / 60)
}

const hhmm = (atMs: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(atMs))

const dayMonth = (atMs: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long' }).format(
    new Date(atMs),
  )

/**
 * A sentence for a day chart whose days do not all begin at local midnight,
 * or null when they do. Read from the window the service counted, a day at a
 * time, so it describes the bars actually drawn rather than a rule about them,
 * and names every change of where days begin, in order: a year crosses two.
 */
export function dayStartNote(counted: Span, timeZone: string): string | null {
  const changes: { at: number; time: string }[] = []
  for (let t = counted.fromMs; t < counted.toMs; t += DAY) {
    const time = hhmm(t, timeZone)
    if (changes.at(-1)?.time !== time) changes.push({ at: t, time })
  }
  const [first, ...later] = changes
  if (!first) return null
  if (first.time === '00:00' && later.length === 0) return null
  const name = (time: string): string => (time === '00:00' ? 'midnight' : time)
  const lead =
    first.time === '00:00'
      ? 'Days are counted from midnight'
      : `Days are counted from ${first.time} rather than midnight`
  const seen = new Set([first.time])
  const clauses = later.map((c) => {
    const again = seen.has(c.time) ? ' again' : ''
    seen.add(c.time)
    return `from ${name(c.time)}${again} from ${dayMonth(c.at + 12 * HOUR, timeZone)} on`
  })
  const after =
    clauses.length === 0
      ? ''
      : clauses.length === 1
        ? `, and ${clauses[0]}, after the clocks changed`
        : `, ${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}, after the clocks changed`
  return `${lead}${after}. Reports are kept by the hour, so a day can only begin on a whole hour of UTC.`
}

/** A bar's label: an hour by its local time, a day by the local date it mostly covers. */
export function bucketLabel(atMs: number, bucket: 'hour' | 'day', timeZone: string): string {
  if (bucket === 'hour') return hhmm(atMs, timeZone)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(atMs + 12 * HOUR))
}

export function describeSpan(s: Span, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return `${f.format(new Date(s.fromMs))} – ${f.format(new Date(s.toMs))}`
}

/**
 * A real calendar date whose next day is also one. The round trip through
 * `addDays(v, 0)` refuses a date that does not exist (`2026-02-30` comes back
 * as `2026-03-02`), and the next day must still be four-digit, because a custom
 * range ends where the day after its last date begins: `9999-12-31` would end
 * in year 10000, which is not a date this module can write.
 */
const isDate = (v: string | null): v is string =>
  v !== null && DATE_RE.test(v) && addDays(v, 0) === v && DATE_RE.test(addDays(v, 1))

/** The choice a URL names, or the default and a sentence saying why. */
export function parseChoice(params: URLSearchParams): { choice: Choice; problem: string | null } {
  const bad = {
    choice: DEFAULT_CHOICE,
    problem: 'That time range could not be used, so this shows the last 7 days.',
  }
  const range = params.get('range')
  const from = params.get('from')
  const to = params.get('to')
  if (range === null && from === null && to === null)
    return { choice: DEFAULT_CHOICE, problem: null }
  if (range !== null) {
    return (PRESETS as readonly string[]).includes(range)
      ? { choice: { preset: range as PresetId }, problem: null }
      : bad
  }
  if (!isDate(from) || !isDate(to) || to < from) return bad
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1
  if (days > MAX_CUSTOM_DAYS) return bad
  return { choice: { from, to }, problem: null }
}

export function choiceParams(choice: Choice): Record<string, string> {
  return 'from' in choice ? { from: choice.from, to: choice.to } : { range: choice.preset }
}

/** The two instants a report is asked for. */
export function toQuery(span: Span): { from: string; to: string } {
  return { from: new Date(span.fromMs).toISOString(), to: new Date(span.toMs).toISOString() }
}

/**
 * A window's local dates, for a filename: "2026-10-01-to-2026-10-07". `to` is
 * exclusive, so the date shown for it is a millisecond before the boundary —
 * the last local date actually in the window, which can equal the start date
 * for a window under a day.
 */
export function windowDatesSlug(query: { from: string; to: string }, timeZone: string): string {
  const from = localDate(Date.parse(query.from), timeZone)
  const to = localDate(Date.parse(query.to) - 1, timeZone)
  return `${from}-to-${to}`
}
