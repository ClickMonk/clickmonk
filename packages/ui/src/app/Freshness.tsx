import { useClient } from '@/api/context'
import type { Status } from '@/api/types'
import { IP_SOURCES, IP_SOURCE_LABELS } from '@/api/vocabulary'
import { browserZone, useNowMs } from '@/app/clock'
import { Link } from 'react-router'
import { formatAge, formatInstant, formatNumber } from './format'
import { useRefresh } from './refresh'
import { useLoad } from './useLoad'

const HOUR = 3_600_000

/** One line per fact, each a sentence; the header shows them small. */
export function describeStatus(s: Status, nowMs: number, timeZone: string): string[] {
  const lines: string[] = []
  if (s.reporting === 'unavailable')
    lines.push('Reporting is unavailable: ClickMonk cannot reach its click store.')
  else if (s.newestHour === null) lines.push('No clicks have reached the reports yet.')
  else {
    const start = formatInstant(s.newestHour, timeZone)
    const end = formatInstant(
      new Date(Date.parse(s.newestHour) + HOUR).toISOString(),
      timeZone,
    ).split(', ')[1]
    lines.push(`Reports include clicks up to ${start}–${end}.`)
  }
  if (s.ipDataProblem !== null) lines.push('The IP data could not be read.')
  else if (s.ipData === null)
    lines.push(
      'No IP data: countries and networks are unknown, and clicks are classed unknown rather than human.',
    )
  else {
    const fetched = IP_SOURCES.map((id) => s.ipData?.[id]?.fetchedAt).filter(
      (t): t is string => !!t,
    )
    const missing = IP_SOURCES.filter((id) => !s.ipData?.[id]).map((id) =>
      IP_SOURCE_LABELS[id].toLowerCase(),
    )
    const oldest = fetched.length ? Math.min(...fetched.map((t) => Date.parse(t))) : null
    const age =
      oldest === null ? 'IP lists never fetched' : `IP lists updated ${formatAge(oldest, nowMs)}`
    lines.push(`${age}${missing.length ? `; ${missing.join(', ')} never fetched` : ''}.`)
  }
  return lines
}

export function Freshness() {
  const client = useClient()
  const { round } = useRefresh()
  const now = useNowMs()
  const r = useLoad((signal) => client.status(signal), [round])
  if (r.state === 'error' || !r.data) return null
  const s = r.data
  const alerts = s.alerts > 500 ? '500+' : formatNumber(s.alerts)
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      {describeStatus(s, now, browserZone()).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {s.alerts > 0 && (
        <Link to="/domains" className="text-warning underline">
          {`${alerts} domain${s.alerts === 1 ? ' needs' : 's need'} attention`}
        </Link>
      )}
    </div>
  )
}
