import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Click, ClickCount, ClickFilters } from '@/api/types'
import { CLASS_LABELS, OUTCOMES, OUTCOME_LABELS, TRAFFIC_CLASSES } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { browserZone } from '@/app/clock'
import { formatNumber } from '@/app/format'
import { useRefresh } from '@/app/refresh'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { WindowPicker } from '@/window/WindowPicker'
import { toQuery } from '@/window/range'
import { useWindow } from '@/window/useWindow'
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ClickRow } from './ClickRow'
import { type ClickFilterChoice, readFilters, writeFilters } from './filters'

const PAGE = 50

/**
 * Every click in the window, newest first, fifty at a time. The address holds
 * the filters and the window, so a reload or a shared link keeps what was
 * chosen. Pages fetched with "Load more" live in state, and — like the
 * window, a filter or a refresh round — start over the moment any of those
 * change: a page fetched under the previous query is never appended to a list
 * it no longer describes.
 */
export function Clicks() {
  const client = useClient()
  const { round } = useRefresh()
  const zone = browserZone()
  const w = useWindow()
  const [params, setParams] = useSearchParams()
  const { filters, problem } = readFilters(params)
  const query: ClickFilters = { ...toQuery(w.span), ...filters }
  const key = JSON.stringify(query)

  const first = useLoad((signal) => client.clicks(query, { limit: PAGE }, signal), [key, round])
  const linkName = useLoad(
    (signal) => (filters.link ? client.link(filters.link, { signal }) : Promise.resolve(null)),
    [filters.link],
  )

  const [more, setMore] = useState<{ clicks: Click[]; nextCursor: string | null } | null>(null)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  const [moreLoading, setMoreLoading] = useState(false)
  // The count and the link a completed export shows are pinned to the query
  // they were counted under, by its key: a count that answers after the
  // operator has since changed a filter is never shown, and the download it
  // offers is always built from the query it counted rather than from
  // whatever the address names by the time it lands.
  const [exported, setExported] = useState<{
    key: string
    query: ClickFilters
    count: ClickCount
  } | null>(null)
  const [exportError, setExportError] = useState<ApiError | null>(null)
  const [exporting, setExporting] = useState(false)

  // A page "Load more" fetches, or a count "Export as CSV" asks for, belongs
  // to one window, one set of filters and one refresh round. `generation` is
  // bumped whenever any of those change, and an answer that arrives after its
  // generation has passed — the operator changed a filter while it was in
  // flight — is dropped rather than joining, or being shown beside, a query
  // it no longer describes.
  const generation = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on exactly these
  useEffect(() => {
    generation.current += 1
    setMore(null)
    setMoreError(null)
    setMoreLoading(false)
    setExported(null)
    setExportError(null)
    setExporting(false)
  }, [key, round])

  const clicks = [...(first.data?.clicks ?? []), ...(more?.clicks ?? [])]
  const cursor = more ? more.nextCursor : (first.data?.nextCursor ?? null)

  const setFilter = (patch: Partial<ClickFilterChoice>) => {
    setParams((prev) => writeFilters(prev, { ...filters, ...patch }))
  }

  const [typedCountry, setTypedCountry] = useState(filters.country ?? '')
  const [lastCountry, setLastCountry] = useState(filters.country ?? '')
  const [countryProblem, setCountryProblem] = useState<string | null>(null)
  if ((filters.country ?? '') !== lastCountry) {
    setLastCountry(filters.country ?? '')
    setTypedCountry(filters.country ?? '')
    setCountryProblem(null)
  }
  // A value that is not two letters is never written to the address — the
  // service would refuse it the same way an unknown class or outcome is
  // refused, but here the operator is still typing, so the refusal is said
  // beside the field instead of round-tripping through a dropped filter.
  const applyCountry = () => {
    const v = typedCountry.trim().toUpperCase()
    setTypedCountry(v)
    if (v === '') {
      setCountryProblem(null)
      setFilter({ country: undefined })
      return
    }
    if (!/^[A-Z]{2}$/.test(v)) {
      setCountryProblem('A country is two letters.')
      return
    }
    setCountryProblem(null)
    setFilter({ country: v })
  }
  const onCountryBlur = (_e: FocusEvent<HTMLInputElement>) => applyCountry()
  const onCountryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyCountry()
    }
  }

  const loadMore = async () => {
    // Also guarded by `disabled` below; guarded here too, so a click that
    // reaches the handler before the disabled attribute takes effect still
    // cannot start a second request for the cursor the first is already
    // fetching.
    if (!cursor || moreLoading) return
    const gen = generation.current
    setMoreLoading(true)
    setMoreError(null)
    try {
      const page = await client.clicks(query, { limit: PAGE, cursor })
      if (generation.current !== gen) return
      setMore((m) => ({
        clicks: [...(m?.clicks ?? []), ...page.clicks],
        nextCursor: page.nextCursor,
      }))
    } catch (err) {
      if (generation.current !== gen) return
      if (err instanceof ApiError) setMoreError(err)
      else throw err
    } finally {
      if (generation.current === gen) setMoreLoading(false)
    }
  }

  const runExport = async () => {
    const gen = generation.current
    const q = query
    const k = key
    setExporting(true)
    setExportError(null)
    try {
      const c = await client.clickCount(q)
      if (generation.current !== gen) return
      setExported({ key: k, query: q, count: c })
    } catch (err) {
      if (generation.current !== gen) return
      if (err instanceof ApiError) setExportError(err)
      else throw err
    } finally {
      if (generation.current === gen) setExporting(false)
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Clicks"
        description="Every click, newest first. The log counts the window to the millisecond; the reports count whole hours, so the two can differ by the clicks in a partial hour."
        actions={<WindowPicker />}
      />
      <div className="flex flex-wrap items-end gap-3">
        {filters.link && (
          <div className="flex items-center gap-2">
            <span className="text-sm">
              {linkName.data?.id === filters.link
                ? `Link: ${linkName.data.host}/${linkName.data.slug}${linkName.data.name ? ` — ${linkName.data.name}` : ''}`
                : 'Link filter applied'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFilter({ link: undefined })}
            >
              Clear the link filter
            </Button>
          </div>
        )}
        <div className="grid gap-1">
          <Label htmlFor="click-class">Traffic class</Label>
          <NativeSelect
            id="click-class"
            value={filters.class ?? ''}
            onChange={(e) => setFilter({ class: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {TRAFFIC_CLASSES.map((c) => (
              <option key={c} value={c}>
                {CLASS_LABELS[c]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="click-outcome">Outcome</Label>
          <NativeSelect
            id="click-outcome"
            value={filters.outcome ?? ''}
            onChange={(e) => setFilter({ outcome: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="click-country">Country</Label>
          <Input
            id="click-country"
            maxLength={2}
            className="w-16"
            value={typedCountry}
            aria-invalid={countryProblem ? true : undefined}
            aria-describedby={countryProblem ? 'click-country-error' : undefined}
            onChange={(e) => setTypedCountry(e.target.value)}
            onBlur={onCountryBlur}
            onKeyDown={onCountryKeyDown}
          />
          {countryProblem && (
            <p id="click-country-error" className="text-sm text-destructive">
              {countryProblem}
            </p>
          )}
        </div>
      </div>
      {problem && <output className="block text-sm text-muted-foreground">{problem}</output>}

      {first.error && <ErrorNote error={first.error} />}
      {first.state === 'ok' && clicks.length === 0 && (
        <p className="text-sm text-muted-foreground">No clicks in this window.</p>
      )}
      {first.state !== 'error' && clicks.length > 0 && (
        <div
          aria-busy={first.state === 'loading'}
          className={first.state === 'loading' ? 'opacity-50' : undefined}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Link</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Address</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clicks.map((c) => (
                <ClickRow key={c.clickId} c={c} zone={zone} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {moreError && <ErrorNote error={moreError} />}
      {cursor && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          disabled={moreLoading || first.state !== 'ok'}
          onClick={loadMore}
        >
          Load more
        </Button>
      )}

      <div className="grid gap-2 border-t pt-4">
        <Button
          type="button"
          variant="secondary"
          className="justify-self-start"
          disabled={exporting}
          onClick={runExport}
        >
          Export as CSV
        </Button>
        {exportError && <ErrorNote error={exportError} />}
        {exported &&
          exported.key === key &&
          (exported.count.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no clicks to export in this window.
            </p>
          ) : exported.count.truncated ? (
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">
                {`This window holds more than ${formatNumber(exported.count.cap)} clicks. The file stops at ${formatNumber(exported.count.cap)}, newest first; choose a shorter window for the rest.`}
              </p>
              <a
                href={client.exportUrl(exported.query)}
                download
                className="text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                {`Download the first ${formatNumber(exported.count.cap)}`}
              </a>
            </div>
          ) : (
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">
                {`${formatNumber(exported.count.count)} ${exported.count.count === 1 ? 'click' : 'clicks'} will be in the file.`}
              </p>
              <a
                href={client.exportUrl(exported.query)}
                download
                className="text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                Download the CSV
              </a>
            </div>
          ))}
      </div>
    </div>
  )
}
