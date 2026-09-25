import type { Link } from '@/api/types'
import { countryName, formatInstant, formatNumber } from '@/app/format'

/**
 * A link's state and rules in the few words the list and the page both show.
 * `status` is what changes how the link answers right now; `rules` is how it
 * is configured. One function, so the two screens cannot come to describe the
 * same link differently.
 */
export function linkFacts(
  l: Link,
  nowMs: number,
  timeZone: string,
): { status: string[]; rules: string[] } {
  const status: string[] = []
  if (!l.enabled) status.push('Disabled: answers as an unknown slug')
  if (l.clickCap !== null) {
    const used = l.capUsed ?? 0
    status.push(
      used >= l.clickCap
        ? `Cap reached: ${formatNumber(used)} of ${formatNumber(l.clickCap)} clicks`
        : `${formatNumber(used)} of ${formatNumber(l.clickCap)} clicks used`,
    )
  }
  if (l.expiresAt !== null) {
    const when = formatInstant(l.expiresAt, timeZone)
    status.push(Date.parse(l.expiresAt) <= nowMs ? `Expired ${when}` : `Expires ${when}`)
  }

  const rules: string[] = []
  if (l.hasPassword) rules.push('Password')
  if (l.targets.length > 1) rules.push(`Rotates between ${l.targets.length} targets`)
  if (l.countries.mode !== 'all') {
    const names = l.countries.list.map(countryName).join(', ')
    rules.push(
      l.countries.mode === 'allow' ? `Countries: only ${names}` : `Countries: all but ${names}`,
    )
  }
  if (!l.passthrough) rules.push('Query string not passed on')
  if (Object.keys(l.trafficActions).length > 0) rules.push('Own traffic actions')
  return { status, rules }
}
