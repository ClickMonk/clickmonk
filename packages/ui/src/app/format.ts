/**
 * How the interface writes a number, an instant, an age and a country. Every
 * screen goes through here, so that "12,345" and "7 Oct 2026, 13:30" mean the
 * same thing everywhere. English, because the interface is; the zone is always
 * a parameter, because the operator's is the only one that matters and the
 * tests pin several.
 */

const number = new Intl.NumberFormat('en-GB')

export const formatNumber = (n: number): string => number.format(n)

export function formatShare(part: number, whole: number): string {
  if (whole === 0) return '–'
  if (part === 0) return '0%'
  const pct = (part / whole) * 100
  if (pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export function formatAge(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  if (s < 3600) return plural(Math.floor(s / 60), 'minute')
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour')
  return plural(Math.floor(s / 86400), 'day')
}

const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' })

export function countryName(code: string): string {
  if (code === '') return 'Unknown'
  try {
    return regions.of(code) ?? code
  } catch {
    return code
  }
}
