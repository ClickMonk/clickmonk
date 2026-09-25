import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Link } from '@/api/types'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { browserZone, useNowMs } from '@/app/clock'
import { formatDate } from '@/app/format'
import { useRefresh } from '@/app/refresh'
import { useLoad } from '@/app/useLoad'
import { Badge } from '@/components/ui/badge'
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
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router'
import { linkFacts } from './linkFacts'

const PAGE = 50

/**
 * Every link, newest first. The search and the domain live in the address, so
 * a reload or a shared link keeps them; the pages loaded so far live in state,
 * and a new search starts again from the first.
 */
export function Links() {
  const client = useClient()
  const { round } = useRefresh()
  const now = useNowMs()
  const zone = browserZone()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const domain = params.get('domain') ?? ''
  const [typed, setTyped] = useState(q)
  const [more, setMore] = useState<{ items: Link[]; nextCursor: string | null } | null>(null)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  const [moreLoading, setMoreLoading] = useState(false)

  // The address can change under the screen (Back, a shared link) without the
  // box being typed in: what it shows follows the address's own `q` whenever
  // that changes, the way `WindowPicker` follows the address's own choice.
  const [lastQ, setLastQ] = useState(q)
  if (q !== lastQ) {
    setLastQ(q)
    setTyped(q)
  }

  const domains = useLoad(() => client.domains(), [round])
  const first = useLoad(
    () => client.links({ ...(q ? { q } : {}), ...(domain ? { domain } : {}), limit: PAGE }),
    [q, domain, round],
  )
  // A page fetched by "Load more" belongs to one search, domain and refresh
  // round. `generation` is bumped every time any of those change, and a page
  // that answers after its generation has passed — the operator started a
  // new search while it was in flight — is dropped rather than appended to a
  // list it no longer describes.
  const generation = useRef(0)
  // A new search, domain or refresh starts from the first page again, and
  // drops whatever a Load-more still in flight from before it was answers with.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on exactly these
  useEffect(() => {
    generation.current += 1
    setMore(null)
    setMoreError(null)
    setMoreLoading(false)
  }, [q, domain, round])

  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])]
  const cursor = more ? more.nextCursor : (first.data?.nextCursor ?? null)
  const verified = new Map((domains.data?.domains ?? []).map((d) => [d.id, d.verified]))

  const search = (e: FormEvent) => {
    e.preventDefault()
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (typed) next.set('q', typed)
      else next.delete('q')
      return next
    })
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
      const page = await client.links({
        ...(q ? { q } : {}),
        ...(domain ? { domain } : {}),
        limit: PAGE,
        cursor,
      })
      if (generation.current !== gen) return
      setMore((m) => ({ items: [...(m?.items ?? []), ...page.items], nextCursor: page.nextCursor }))
    } catch (err) {
      if (generation.current !== gen) return
      if (err instanceof ApiError) setMoreError(err)
      else throw err
    } finally {
      if (generation.current === gen) setMoreLoading(false)
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Links"
        actions={
          <Button asChild>
            <RouterLink to="/links/new">New link</RouterLink>
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-2" onSubmit={search}>
          <div className="grid gap-1">
            <Label htmlFor="link-search">Search links</Label>
            {/* 100 is admin's own MAX_LINK_SEARCH (packages/admin/src/links.ts),
                restated rather than imported — the interface imports nothing
                from a service package at runtime. */}
            <Input
              id="link-search"
              type="search"
              maxLength={100}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="grid gap-1">
          <Label htmlFor="link-domain">Domain</Label>
          <NativeSelect
            id="link-domain"
            value={domain}
            onChange={(e) =>
              setParams((prev) => {
                const next = new URLSearchParams(prev)
                if (e.target.value) next.set('domain', e.target.value)
                else next.delete('domain')
                return next
              })
            }
          >
            <option value="">All domains</option>
            {(domains.data?.domains ?? []).map((d) => (
              <option key={d.id} value={d.host}>
                {d.host}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {first.error && <ErrorNote error={first.error} />}
      {first.state === 'ok' && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {q ? `No link matches “${q}”.` : 'No links yet.'}
        </p>
      )}
      {first.state !== 'error' && items.length > 0 && (
        <div aria-busy={first.state === 'loading'}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Link</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => {
                const facts = linkFacts(l, now, zone)
                const unverified = verified.get(l.domainId) === false
                return (
                  <TableRow key={l.id}>
                    <TableCell className="max-w-72">
                      <RouterLink
                        to={`/links/${encodeURIComponent(l.id)}`}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {`${l.host}/${l.slug}`}
                      </RouterLink>
                      {l.name && <p className="truncate text-xs text-muted-foreground">{l.name}</p>}
                    </TableCell>
                    <TableCell className="max-w-72 truncate text-sm text-muted-foreground">
                      {l.targets.length === 1 ? l.targets[0]?.url : `${l.targets.length} targets`}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {unverified && (
                          <Badge variant="destructive">Domain not verified: answers 404</Badge>
                        )}
                        {[...facts.status, ...facts.rules].map((f) => (
                          <Badge key={f} variant="secondary">
                            {f}
                          </Badge>
                        ))}
                        {/* A link with nothing to say about it is serving:
                            said, so the cell does not read as missing data. */}
                        {!unverified && facts.status.length + facts.rules.length === 0 && (
                          <span className="text-sm text-muted-foreground">Active</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(l.createdAt, zone)}
                    </TableCell>
                  </TableRow>
                )
              })}
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
    </div>
  )
}
