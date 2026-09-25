import type {
  NonHumanClass,
  RetentionSettings,
  Settings,
  SettingsInput,
  TrafficAction,
} from '@/api/types'
import { MAX_ABUSER_THRESHOLD, MAX_RETENTION_DAYS, NON_HUMAN_CLASSES } from '@/api/vocabulary'
import { formatNumber } from '@/app/format'

export interface SettingsFormState {
  actions: Record<NonHumanClass, TrafficAction>
  safeUrl: string
  abuserThreshold: string
  raw: { forever: boolean; days: string }
  ip: { forever: boolean; days: string }
}

const period = (days: number | null | undefined, known: boolean) =>
  !known
    ? { forever: false, days: '' }
    : days === null
      ? { forever: true, days: '' }
      : { forever: false, days: String(days) }

/** The settings as the form holds them. Unreadable retention is empty, not the defaults. */
export function settingsFormOf(s: Settings): SettingsFormState {
  const known = s.retention !== null
  return {
    actions: { ...s.traffic.actions },
    safeUrl: s.traffic.safeUrl ?? '',
    abuserThreshold: String(s.traffic.abuserThreshold),
    raw: period(s.retention?.rawRetentionDays, known),
    ip: period(s.retention?.ipRetentionDays, known),
  }
}

const days = (p: { forever: boolean; days: string }): number | null =>
  p.forever ? null : Number(p.days)

export function settingsInputOf(f: SettingsFormState): SettingsInput {
  return {
    traffic: {
      actions: f.actions,
      safeUrl: f.safeUrl === '' ? null : f.safeUrl,
      abuserThreshold: Number(f.abuserThreshold),
    },
    retention: { rawRetentionDays: days(f.raw), ipRetentionDays: days(f.ip) },
  }
}

const WHOLE = /^\d+$/

export function settingsProblems(f: SettingsFormState): Record<string, string> {
  const out: Record<string, string> = {}
  const t = Number(f.abuserThreshold)
  if (!WHOLE.test(f.abuserThreshold) || t < 1 || t > MAX_ABUSER_THRESHOLD)
    out.abuserThreshold = `A whole number from 1 to ${formatNumber(MAX_ABUSER_THRESHOLD)}.`
  for (const k of ['raw', 'ip'] as const) {
    const p = f[k]
    if (p.forever) continue
    if (p.days === '') out[k] = 'Choose a number of days, or for ever.'
    else if (!WHOLE.test(p.days) || Number(p.days) < 1 || Number(p.days) > MAX_RETENTION_DAYS)
      out[k] = `A whole number of days from 1 to ${formatNumber(MAX_RETENTION_DAYS)}.`
  }
  if (f.safeUrl === '' && NON_HUMAN_CLASSES.some((c) => f.actions[c] === 'safe'))
    out.safeUrl = 'The safe action needs a safe URL.'
  return out
}

/** Keeps less than before: a number where it was for ever, or a smaller number. */
const shorter = (before: number | null | undefined, after: number | null) =>
  after !== null && (before === null || before === undefined || after < before)

/**
 * What a save that deletes data must confirm: the sentence to show, and the
 * name of the button that agrees to it — naming clicks, addresses or both,
 * whichever the save actually shortens. Null when the save deletes nothing.
 * Settings the service could not read count as keeping everything, which is
 * what the service does with them.
 */
export function deletion(
  before: RetentionSettings | null,
  after: RetentionSettings,
): { sentence: string; action: string } | null {
  const clicks = shorter(before?.rawRetentionDays, after.rawRetentionDays)
  const addresses = shorter(before?.ipRetentionDays, after.ipRetentionDays)
  if (!clicks && !addresses) return null
  const parts: string[] = []
  if (clicks)
    parts.push(
      `Clicks older than ${after.rawRetentionDays} days will be deleted within the hour, when the worker next runs.`,
    )
  if (addresses)
    parts.push(
      `Addresses older than ${after.ipRetentionDays} days will be blanked within the hour, when the worker next runs.`,
    )
  const action =
    clicks && addresses
      ? 'Delete older data and save'
      : clicks
        ? 'Delete older clicks and save'
        : 'Blank older addresses and save'
  return { sentence: `${parts.join(' ')} This cannot be undone.`, action }
}
