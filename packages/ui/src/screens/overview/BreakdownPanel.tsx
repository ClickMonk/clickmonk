import { useClient } from '@/api/context'
import type { WindowQuery } from '@/api/types'
import { DIMENSION_LABELS } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { downloadCsv } from '@/app/csv'
import { formatNumber, formatShare } from '@/app/format'
import { useLoad } from '@/app/useLoad'
import { Bars } from '@/charts/Bars'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  const title = props.title ?? DIMENSION_LABELS[props.dimension]
  const r = useLoad(
    (signal) => client.breakdown(props.query, props.dimension, limit, signal),
    [props.query.from, props.query.to, props.query.link, props.dimension, limit, props.round],
  )
  const rows = (r.data?.rows ?? []).map((row) => ({
    key: row.value,
    label: rowLabel(props.dimension, row, { targets: props.targets }),
    value: row.clicks,
    secondary: `${formatNumber(row.clicks)} · ${formatShare(row.clicks, props.total ?? 0)}`,
    row,
  }))
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {rows.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Download ${title.toLowerCase()} as CSV`}
            onClick={() =>
              downloadCsv(`${props.dimension}.csv`, [
                [COLUMN[props.dimension], 'Code', 'Clicks', 'Visitors'],
                ...rows.map((x) => [x.label, x.row.value, x.row.clicks, x.row.visitors]),
              ])
            }
          >
            CSV
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {r.error && <ErrorNote error={r.error} />}
        {r.state === 'ok' && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing in this window.</p>
        )}
        {rows.length > 0 && <Bars rows={rows} />}
        {r.data?.truncated && limit === FEW && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Top 10 shown.</span>
            <Button type="button" variant="link" size="sm" onClick={() => setLimit(ALL)}>
              Show all
            </Button>
          </div>
        )}
        {r.data?.truncated && limit === ALL && (
          <p className="text-sm text-muted-foreground">The top 100 are shown.</p>
        )}
      </CardContent>
    </Card>
  )
}
