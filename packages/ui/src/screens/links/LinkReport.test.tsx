import type { ApiClient } from '@/api/client'
import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Breakdown, Link } from '@/api/types'
import { NowProvider } from '@/app/clock'
import { RefreshProvider, useRefresh } from '@/app/refresh'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { LinkReport } from './LinkReport'

const LINK: Link = {
  id: 'l1',
  domainId: 'd1',
  host: 'go.example.test',
  slug: 'spring',
  url: 'https://go.example.test/spring',
  name: 'Spring offer',
  enabled: true,
  targets: [
    { id: 't1', url: 'https://example.com/a', weight: 70 },
    { id: 't2', url: 'https://example.com/b', weight: 30 },
  ],
  backupUrl: null,
  deviceUrls: {},
  returningUrl: null,
  countries: { mode: 'all' },
  clickCap: null,
  capUsed: null,
  expiresAt: null,
  passthrough: true,
  trafficActions: {},
  hasPassword: false,
  createdAt: '2026-09-01T00:00:00.000Z',
}
const W = { from: '2026-09-30T14:00:00.000Z', to: '2026-10-07T14:00:00.000Z' }
const rows = (d: string): Breakdown => ({
  window: W,
  link: 'l1',
  dimension: d,
  truncated: false,
  rows: d === 'target' ? [{ value: 't1', clicks: 7, visitors: 5 }] : [],
})

function show(link: () => Promise<Link>, overrides: Partial<ApiClient> = {}) {
  const client = fakeClient({
    link: link as never,
    summary: () =>
      Promise.resolve({
        window: W,
        link: 'l1',
        clicks: 7,
        visitors: 5,
        byClass: {},
        byAction: {},
        byOutcome: {},
        newestHour: null,
      }),
    timeseries: () =>
      Promise.resolve({
        window: W,
        link: 'l1',
        bucket: 'day' as const,
        buckets: [],
        newestHour: null,
      }),
    breakdown: ((_w: unknown, d: string) => Promise.resolve(rows(d))) as never,
    deleteLink: () => Promise.resolve({ ok: true as const }),
    ...overrides,
  })
  render(
    <NowProvider now={() => Date.parse('2026-10-07T03:00:00.000Z')}>
      <MemoryRouter initialEntries={['/links/l1?range=7d']}>
        <ClientProvider client={client}>
          <Routes>
            <Route path="/links/:id" element={<LinkReport />} />
            <Route path="/links" element={<h1>the list</h1>} />
          </Routes>
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
  return { client, user: userEvent.setup() }
}

/** A button that navigates within the router, standing in for a click on
 *  another link's row — the way the address moves from one link to another. */
function GoTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)}>
      Go to {to}
    </button>
  )
}

/** Two links, one of them controlled by hand: for the race between a
 *  navigation and the link it left still loading. */
function showTwo(a: Link, b: Link, resolveB: { current: (l: Link) => void }) {
  const client = fakeClient({
    link: ((linkId: string) =>
      linkId === a.id
        ? Promise.resolve(a)
        : new Promise<Link>((resolve) => {
            resolveB.current = resolve
          })) as never,
    summary: () =>
      Promise.resolve({
        window: W,
        link: null,
        clicks: 0,
        visitors: 0,
        byClass: {},
        byAction: {},
        byOutcome: {},
        newestHour: null,
      }),
    timeseries: () =>
      Promise.resolve({
        window: W,
        link: null,
        bucket: 'day' as const,
        buckets: [],
        newestHour: null,
      }),
    breakdown: ((_w: unknown, d: string) =>
      Promise.resolve({
        window: W,
        link: null,
        dimension: d,
        truncated: false,
        rows: [],
      })) as never,
  })
  render(
    <NowProvider now={() => Date.parse('2026-10-07T03:00:00.000Z')}>
      <MemoryRouter initialEntries={[`/links/${a.id}?range=7d`]}>
        <ClientProvider client={client}>
          <GoTo to={`/links/${b.id}?range=7d`} />
          <Routes>
            <Route path="/links/:id" element={<LinkReport />} />
            <Route path="/links" element={<h1>the list</h1>} />
          </Routes>
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
  return { client, user: userEvent.setup() }
}

describe('a link’s own page', () => {
  it('is titled by the link’s name, and shows the URL to copy', async () => {
    show(() => Promise.resolve(LINK))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Spring offer' }),
    ).toBeInTheDocument()
    expect(screen.getByText('https://go.example.test/spring')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy the link' })).toBeInTheDocument()
  })

  it('asks for every report about this link and no other', async () => {
    const { client } = show(() => Promise.resolve(LINK))
    await screen.findAllByText('https://example.com/a')
    const scoped = client.calls.filter((c) =>
      ['summary', 'timeseries', 'breakdown'].includes(c.method),
    )
    expect(scoped.every((c) => (c.args[0] as { link?: string }).link === 'l1')).toBe(true)
    expect(
      client.calls
        .filter((c) => c.method === 'breakdown')
        .map((c) => c.args[1])
        .sort(),
    ).toEqual(['class', 'country', 'device', 'outcome', 'referrer', 'target'])
  })

  // Twice: once in the link's own list of targets, and once as the breakdown's
  // row for the target the clicks went to. Without the map it would be one,
  // and the row would say "A target since removed".
  it('names each target by its URL in the breakdown', async () => {
    show(() => Promise.resolve(LINK))
    await waitFor(() => expect(screen.getAllByText('https://example.com/a')).toHaveLength(2))
    expect(screen.queryByText('A target since removed')).not.toBeInTheDocument()
  })

  it('deletes the link after saying what goes with it, and returns to the list', async () => {
    const { client, user } = show(() => Promise.resolve(LINK))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Its targets and its click counter go with it. Clicks already recorded stay in the reports.',
    )
    await user.click(screen.getByRole('button', { name: 'Delete link' }))
    expect(await screen.findByRole('heading', { name: 'the list' })).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'deleteLink').map((c) => c.args)).toEqual([
      ['l1'],
    ])
  })

  it('says there is no such link', async () => {
    show(() => Promise.reject(new ApiError(404, 'not_found', 'no such link')))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No such link' }),
    ).toBeInTheDocument()
  })

  it('keeps the page and shows the error when deleting fails, rather than navigating away', async () => {
    const { client, user } = show(() => Promise.resolve(LINK), {
      deleteLink: () => Promise.reject(new ApiError(409, 'has_clicks', 'could not delete')),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete link' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Spring offer' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'the list' })).not.toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'deleteLink')).toHaveLength(1)
  })

  it('keeps the current time window on the Clicks link', async () => {
    show(() => Promise.resolve(LINK))
    expect(await screen.findByRole('link', { name: 'Clicks' })).toHaveAttribute(
      'href',
      '/clicks?link=l1&range=7d',
    )
  })

  it('copies exactly the link’s own URL, nothing else', async () => {
    const { user } = show(() => Promise.resolve(LINK))
    const write = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(await screen.findByRole('button', { name: 'Copy the link' }))
    expect(write).toHaveBeenCalledWith('https://go.example.test/spring')
    expect(write).toHaveBeenCalledTimes(1)
  })

  // A non-404 failure from a later refresh still names the link, since the
  // id has not changed and the link itself is still known — only the answer
  // to this particular refresh failed.
  it('keeps naming the link beside an error from a later refresh', async () => {
    let calls = 0
    const client = fakeClient({
      link: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(LINK)
        return Promise.reject(new ApiError(500, 'server_error', 'the service is down'))
      }) as never,
      summary: () =>
        Promise.resolve({
          window: W,
          link: 'l1',
          clicks: 7,
          visitors: 5,
          byClass: {},
          byAction: {},
          byOutcome: {},
          newestHour: null,
        }),
      timeseries: () =>
        Promise.resolve({
          window: W,
          link: 'l1',
          bucket: 'day' as const,
          buckets: [],
          newestHour: null,
        }),
      breakdown: ((_w: unknown, d: string) => Promise.resolve(rows(d))) as never,
      deleteLink: () => Promise.resolve({ ok: true as const }),
    })
    function Bump() {
      const { refresh } = useRefresh()
      return (
        <button type="button" onClick={refresh}>
          Bump
        </button>
      )
    }
    render(
      <NowProvider now={() => Date.parse('2026-10-07T03:00:00.000Z')}>
        <RefreshProvider>
          <MemoryRouter initialEntries={['/links/l1?range=7d']}>
            <ClientProvider client={client}>
              <Bump />
              <Routes>
                <Route path="/links/:id" element={<LinkReport />} />
                <Route path="/links" element={<h1>the list</h1>} />
              </Routes>
            </ClientProvider>
          </MemoryRouter>
        </RefreshProvider>
      </NowProvider>,
    )
    const user = userEvent.setup()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Spring offer' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Bump' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Spring offer' })).toBeInTheDocument()
  })

  // A refresh that answers 404, then another refresh started before that
  // answer's page ever shows anything else: the second refresh has no
  // previous answer to fall back on — the link the first refresh named is
  // gone as far as this page knows — so nothing of it (not the title, not
  // Edit or Delete) may come back on screen while the second refresh is
  // still in flight.
  it('never shows the report again while a refresh started after a 404 is still in flight', async () => {
    let calls = 0
    let resolveThird: ((l: Link) => void) | undefined
    const client = fakeClient({
      link: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(LINK)
        if (calls === 2) return Promise.reject(new ApiError(404, 'not_found', 'no such link'))
        return new Promise<Link>((resolve) => {
          resolveThird = resolve
        })
      }) as never,
      summary: () =>
        Promise.resolve({
          window: W,
          link: 'l1',
          clicks: 7,
          visitors: 5,
          byClass: {},
          byAction: {},
          byOutcome: {},
          newestHour: null,
        }),
      timeseries: () =>
        Promise.resolve({
          window: W,
          link: 'l1',
          bucket: 'day' as const,
          buckets: [],
          newestHour: null,
        }),
      breakdown: ((_w: unknown, d: string) => Promise.resolve(rows(d))) as never,
      deleteLink: () => Promise.resolve({ ok: true as const }),
    })
    function Bump() {
      const { refresh } = useRefresh()
      return (
        <button type="button" onClick={refresh}>
          Bump
        </button>
      )
    }
    render(
      <NowProvider now={() => Date.parse('2026-10-07T03:00:00.000Z')}>
        <RefreshProvider>
          <MemoryRouter initialEntries={['/links/l1?range=7d']}>
            <ClientProvider client={client}>
              <Bump />
              <Routes>
                <Route path="/links/:id" element={<LinkReport />} />
                <Route path="/links" element={<h1>the list</h1>} />
              </Routes>
            </ClientProvider>
          </MemoryRouter>
        </RefreshProvider>
      </NowProvider>,
    )
    const user = userEvent.setup()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Spring offer' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Bump' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No such link' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Bump' }))
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Spring offer' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    resolveThird?.(LINK)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Spring offer' }),
    ).toBeInTheDocument()
  })

  it('falls back to a plain title beside a non-404 error when nothing is known about the link yet', async () => {
    show(() => Promise.reject(new ApiError(500, 'server_error', 'the service is down')))
    expect(await screen.findByRole('heading', { level: 1, name: 'Link' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  // A navigation from one link to another must not show the first link's
  // title, URL or facts while the second is still loading, and must stop
  // asking for the first link's reports once it has been left.
  it('shows nothing of the old link once the address names a different one still loading', async () => {
    const A: Link = LINK
    const B: Link = {
      ...LINK,
      id: 'l2',
      slug: 'summer',
      url: 'https://go.example.test/summer',
      name: 'Summer offer',
    }
    const resolveB = { current: (_l: Link) => {} }
    const { client, user } = showTwo(A, B, resolveB)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Spring offer' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(client.calls.some((c) => c.method === 'breakdown')).toBe(true))
    const before = client.calls.filter(
      (c) => c.method === 'breakdown' && (c.args[0] as { link?: string }).link === 'l1',
    ).length
    await user.click(screen.getByRole('button', { name: `Go to /links/${B.id}?range=7d` }))
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Spring offer' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 0))
    const after = client.calls.filter(
      (c) => c.method === 'breakdown' && (c.args[0] as { link?: string }).link === 'l1',
    ).length
    expect(after).toBe(before)
    resolveB.current(B)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Summer offer' }),
    ).toBeInTheDocument()
  })
})
