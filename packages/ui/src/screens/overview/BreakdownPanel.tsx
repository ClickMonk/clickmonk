import { useClient } from '@/api/context'
import type { WindowQuery } from '@/api/types'
import { DIMENSION_LABELS } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { browserZone } from '@/app/clock'
import { downloadCsv } from '@/app/csv'
import { formatNumber, formatShare } from '@/app/format'
import { useLoad } from '@/app/useLoad'
import { Bars } from '@/charts/Bars'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { windowDatesSlug } from '@/window/range'
import { useState } from 'react'
import { type Dimension, rowLabel } from './labels'

const FEW = 10
const ALL = 100

/** The singular heading for a CSV's first column. */
const COLUMN: Record<Dimension, string> = {
  country: 'Country',
  device: 'Device',
  os: 'Operating system',
  browser: 'Browser',
  referrer: 'Referrer',
  target: 'Target',
  class: 'Traffic class',
  action: 'Action',
  outcome: 'Outcome',
  link: 'Link',
}

/** What the CSV's second column holds: a code where the dimension has one. */
const VALUE_COLUMN: Record<Dimension, string> = {
  country: 'Code',
  device: 'Value',
  os: 'Value',
  browser: 'Value',
  referrer: 'Value',
  target: 'Value',
  class: 'Value',
  action: 'Value',
  outcome: 'Value',
  link: 'Link ID',
}

/**
 * One dimension's top values. Ten at first; a hundred on "Show all", which is a
 * second request rather than the first asking for more, because a glance at an
 * overview is the common case. A list the service cut says so.
 */
export function BreakdownPanel(props: {
  query: WindowQuery
  dimension: Dimension
  total: number | undefined
  round: number
  title?: string
  targets?: Map<string, string>
}) {
  const client = useClient()
  const [limit, setLimit] = useState(FEW)
  // "Show all" is a choice about the window it was pressed in; a new window
  // starts over at the top ten rather than silently asking the new window for
  // a hundred rows nobody chose to see there. Reset during render, the way
  // `useWindow` and `WindowPicker` follow the address's own change: an effect
  // would still fire the old (stale) limit's request once before the reset
  // took hold, on the very render that changed the window.
  const queryKey = `${props.query.from}|${props.query.to}|${props.query.link ?? ''}`
  const [lastQueryKey, setLastQueryKey] = useState(queryKey)
  if (queryKey !== lastQueryKey) {
    setLastQueryKey(queryKey)
    setLimit(FEW)
  }
  const title = props.title ?? DIMENSION_LABELS[props.dimension]
  const r = useLoad(
    (signal) => client.breakdown(props.query, props.dimension, limit, signal),
    [props.query.from, props.query.to, props.query.link, props.dimension, limit, props.round],
  )
  // A failed reload drops what it was showing: the alternative — the old
  // window's rows sitting next to a new window's error — reads as still
  // current. A loading reload keeps them, dimmed, so a fast reload does not
  // blank the panel.
  // A share divides these rows by `total`, and the two only ever answer the
  // same request when this panel's own load has finished ('ok') *and* a total
  // was given — `total` is undefined whenever the summary it comes from is
  // itself not `'ok'` for the current window (see Report.tsx). Without this,
  // a still-loading panel's dimmed, previous-window rows would show a share
  // against whatever total the *new* window's summary just answered with.
  const shareKnown = r.state === 'ok' && props.total !== undefined
  const rows =
    r.state === 'error'
      ? []
      : (r.data?.rows ?? []).map((row) => ({
          key: row.value,
          label: rowLabel(props.dimension, row, { targets: props.targets }),
          value: row.clicks,
          secondary: shareKnown
            ? `${formatNumber(row.clicks)} · ${formatShare(row.clicks, props.total as number)}`
            : formatNumber(row.clicks),
          row,
        }))
  const stale = r.state === 'loading'
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {rows.length > 0 && r.state === 'ok' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Download ${title.toLowerCase()} as CSV`}
            onClick={() =>
              downloadCsv(
                `${DIMENSION_LABELS[props.dimension].toLowerCase()}-${windowDatesSlug(props.query, browserZone())}.csv`,
                [
                  [COLUMN[props.dimension], VALUE_COLUMN[props.dimension], 'Clicks', 'Visitors'],
                  ...rows.map((x) => [x.label, x.row.value, x.row.clicks, x.row.visitors]),
                ],
              )
            }
          >
            CSV
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3" aria-busy={stale}>
        {r.error && <ErrorNote error={r.error} />}
        {r.state === 'ok' && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing in this window.</p>
        )}
        {rows.length > 0 && (
          <div data-testid="rows" className={stale ? 'opacity-50' : undefined}>
            <Bars rows={rows} />
          </div>
        )}
        {r.data?.truncated && rows.length > 0 && limit === FEW && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Top 10 shown.</span>
            <Button type="button" variant="link" size="sm" onClick={() => setLimit(ALL)}>
              Show all
            </Button>
          </div>
        )}
        {r.data?.truncated && rows.length > 0 && limit === ALL && (
          <p className="text-sm text-muted-foreground">The top 100 are shown.</p>
        )}
      </CardContent>
    </Card>
  )
}
