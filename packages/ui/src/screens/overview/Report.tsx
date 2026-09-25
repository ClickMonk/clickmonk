import { useClient } from '@/api/context'
import { ErrorNote } from '@/app/ErrorNote'
import { downloadCsv } from '@/app/csv'
import { useRefresh } from '@/app/refresh'
import { useLoad } from '@/app/useLoad'
import { Columns } from '@/charts/Columns'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CountedWindow } from '@/window/CountedWindow'
import { toQuery, windowDatesSlug } from '@/window/range'
import { useWindow } from '@/window/useWindow'
import { useState } from 'react'
import { BreakdownPanel } from './BreakdownPanel'
import { SummaryCards } from './SummaryCards'
import { chartBucketLabels } from './chartLabels'
import type { Dimension } from './labels'

export type Panel = { dimension: Dimension; title?: string; targets?: Map<string, string> }

export const OVERVIEW_PANELS: Panel[] = [
  { dimension: 'link', title: 'Top links' },
  { dimension: 'country' },
  { dimension: 'referrer' },
  { dimension: 'device' },
  { dimension: 'os' },
  { dimension: 'browser' },
  { dimension: 'class' },
  { dimension: 'outcome' },
]

/**
 * A report over the window: the numbers, the chart and the panels, for the
 * whole install or one link. Every request depends on the window, the link and
 * the refresh round, and nothing else.
 */
export function Report({ link, panels }: { link?: string; panels: Panel[] }) {
  const client = useClient()
  const { round } = useRefresh()
  const w = useWindow()
  const query = { ...toQuery(w.span), ...(link ? { link } : {}) }
  const deps = [query.from, query.to, link, round]
  const summary = useLoad((signal) => client.summary(query, signal), deps)
  const series = useLoad(
    (signal) => client.timeseries(query, w.bucket, w.offset, signal),
    [...deps, w.bucket, w.offset],
  )
  const [metric, setMetric] = useState<'clicks' | 'visitors'>('clicks')
  const bucket = series.data?.bucket ?? w.bucket
  const labels = chartBucketLabels(series.data?.buckets ?? [], bucket, w.timeZone)
  const buckets = (series.data?.buckets ?? []).map((b, i) => ({
    label: labels[i] ?? '',
    value: b[metric],
    at: b.at,
    clicks: b.clicks,
    visitors: b.visitors,
  }))
  // A share divides one window's rows by another window's total unless both
  // come from the same, finished request: `total` is only ever the current
  // query's own answer, never a stale one left over from the window before.
  const total = summary.state === 'ok' ? summary.data?.clicks : undefined
  // The same rule as a breakdown panel, for the two blocks below: an error
  // drops what it was showing (the old window's numbers beside its own
  // request's error read as still current), and a reload in flight keeps the
  // old numbers up, marked busy and dimmed, rather than blanking on every
  // window change or refresh.
  const summaryStale = summary.state === 'loading'
  const seriesStale = series.state === 'loading'

  return (
    <div className="grid gap-6">
      {summary.error && <ErrorNote error={summary.error} />}
      {summary.data && summary.state !== 'error' && (
        <div aria-busy={summaryStale} className="grid gap-6">
          <CountedWindow counted={summary.data.window} />
          <SummaryCards s={summary.data} />
        </div>
      )}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{bucket === 'hour' ? 'By hour' : 'By day'}</CardTitle>
          <div className="flex gap-1">
            {(['clicks', 'visitors'] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={metric === m ? 'default' : 'ghost'}
                aria-pressed={metric === m}
                onClick={() => setMetric(m)}
              >
                {m === 'clicks' ? 'Clicks' : 'Visitors'}
              </Button>
            ))}
            {buckets.length > 0 && series.state === 'ok' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Download the chart as CSV"
                onClick={() =>
                  downloadCsv(`chart-${windowDatesSlug(query, w.timeZone)}.csv`, [
                    ['Bucket start (UTC)', 'Label', 'Clicks', 'Visitors'],
                    ...buckets.map((b) => [b.at, b.label, b.clicks, b.visitors]),
                  ])
                }
              >
                CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-2">
          {series.error && <ErrorNote error={series.error} />}
          {series.data && series.state !== 'error' && (
            <div aria-busy={seriesStale} className="grid gap-2">
              <Columns
                buckets={buckets}
                unit={metric}
                span={bucket}
                label={`${metric === 'clicks' ? 'Clicks' : 'Visitors'} by ${bucket}`}
              />
              {metric === 'visitors' && (
                <p className="text-xs text-muted-foreground">
                  Visitors are counted per bar; adding bars together counts a returning visitor more
                  than once.
                </p>
              )}
              <CountedWindow counted={series.data.window} bucket={series.data.bucket} />
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {panels.map((p) => (
          <BreakdownPanel
            key={p.dimension}
            query={query}
            dimension={p.dimension}
            title={p.title}
            targets={p.targets}
            total={total}
            round={round}
          />
        ))}
      </div>
    </div>
  )
}
