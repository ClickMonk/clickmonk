import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Domain, Link, Page } from '@/api/types'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Link as RouterLink, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Links } from './Links'

const domain = (host: string, verified: boolean): Domain => ({
  id: `d-${host}`,
  host,
  verified,
  rootUrl: null,
  notFoundUrl: null,
  verificationRecord: {
    name: `_clickmonk.${host}`,
    type: 'TXT',
    value: 'clickmonk-verify=0123456789abcdef0123456789abcdef',
  },
  lastCheck: null,
  passedAt: null,
  handVerified: false,
})

const link = (slug: string, host = 'go.example.test', over: Partial<Link> = {}): Link => ({
  id: `l-${slug}`,
  domainId: `d-${host}`,
  host,
  slug,
  url: `https://${host}/${slug}`,
  name: null,
  enabled: true,
  targets: [{ id: 't1', url: 'https://example.com/offer', weight: 100 }],
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
  ...over,
})

function Where() {
  const l = useLocation()
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>
}

const domains = () =>
  Promise.resolve({
    domains: [domain('go.example.test', true), domain('new.example.test', false)],
    truncated: false,
  })

function show(pages: (q: Record<string, unknown>) => Page<Link>, at = '/links') {
  const client = fakeClient({
    links: ((q: Record<string, unknown>) => Promise.resolve(pages(q))) as never,
    domains,
  })
  return showWith(client, at)
}

/** `showWith` renders with a caller-built client, for a scenario `show()` can't express. */
function showWith(client: ReturnType<typeof fakeClient>, at = '/links') {
  render(
    <MemoryRouter initialEntries={[at]}>
      <ClientProvider client={client}>
        <Routes>
          <Route path="/links" element={<Links />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <Where />
      </ClientProvider>
    </MemoryRouter>,
  )
  return { client, user: userEvent.setup() }
}

const linkCalls = (client: ReturnType<typeof fakeClient>) =>
  client.calls.filter((c) => c.method === 'links').map((c) => c.args[0])

describe('the link list', () => {
  it('is titled as a screen, and offers a new link', () => {
    show(() => ({ items: [], nextCursor: null }))
    expect(screen.getByRole('heading', { level: 1, name: 'Links' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New link' })).toHaveAttribute('href', '/links/new')
  })

  it('shows each link where it lives, and links to its page', async () => {
    show(() => ({ items: [link('spring')], nextCursor: null }))
    const row = await screen.findByRole('link', { name: 'go.example.test/spring' })
    expect(row).toHaveAttribute('href', '/links/l-spring')
  })

  it('says a link on an unverified domain answers 404', async () => {
    show(() => ({ items: [link('soon', 'new.example.test'), link('spring')], nextCursor: null }))
    const rows = await screen.findAllByRole('row')
    expect(
      within(rows[1] as HTMLElement).getByText('Domain not verified: answers 404'),
    ).toBeInTheDocument()
    expect(
      within(rows[2] as HTMLElement).queryByText('Domain not verified: answers 404'),
    ).not.toBeInTheDocument()
  })

  it('says a plain link is active, and says nothing of the kind beside a badge', async () => {
    show(() => ({
      items: [
        link('spring'),
        link('off', 'go.example.test', { enabled: false }),
        link('soon', 'new.example.test'),
        link('locked', 'go.example.test', { hasPassword: true }),
      ],
      nextCursor: null,
    }))
    const rows = await screen.findAllByRole('row')
    const state = (i: number) =>
      within(rows[i] as HTMLElement).getAllByRole('cell')[2] as HTMLElement
    expect(state(1)).toHaveTextContent(/^Active$/)
    expect(state(2)).toHaveTextContent(/^Disabled: answers as an unknown slug$/)
    expect(state(3)).toHaveTextContent(/^Domain not verified: answers 404$/)
    // A rule and no status: the rule is what the cell says, with no "Active".
    expect(state(4)).toHaveTextContent(/^Password$/)
  })

  // A domain the truncated /api/domains answer left out (issue #22) is not
  // known to be unverified, so the list must not guess: no badge rather than
  // a wrong one.
  it('shows no badge for a link whose domain is missing from the domains list', async () => {
    show(() => ({ items: [link('spring', 'unknown.example.test')], nextCursor: null }))
    const rows = await screen.findAllByRole('row')
    expect(
      within(rows[1] as HTMLElement).queryByText('Domain not verified: answers 404'),
    ).not.toBeInTheDocument()
  })

  it('searches by what was typed, and keeps the search in the address', async () => {
    const { client, user } = show(() => ({ items: [], nextCursor: null }))
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), '50% off')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getAllByLabelText('address')[0]).toHaveTextContent('/links?q=50%25+off')
    expect(linkCalls(client).at(-1)).toStrictEqual({ q: '50% off', limit: 50 })
  })

  it('filters by domain', async () => {
    const { client, user } = show(() => ({ items: [], nextCursor: null }))
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'new.example.test',
    )
    expect(linkCalls(client).at(-1)).toEqual({ domain: 'new.example.test', limit: 50 })
  })

  // Two Load-mores, not one: the first click's "more" page starts from a null
  // state, where appending and replacing look the same. Only a second click
  // tells them apart — replacing would drop "z" the moment "y" arrives.
  it('loads the next page after the ones shown, keeps every earlier page loaded, and stops when there is none', async () => {
    const { client, user } = show((q) => {
      if (q.cursor === undefined) return { items: [link('b'), link('a')], nextCursor: '5.l-a' }
      if (q.cursor === '5.l-a') return { items: [link('z')], nextCursor: '9.l-z' }
      return { items: [link('y')], nextCursor: null }
    })
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('link', { name: 'go.example.test/z' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/b' })).toBeInTheDocument()
    expect(linkCalls(client).at(-1)).toEqual({ limit: 50, cursor: '5.l-a' })
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('link', { name: 'go.example.test/y' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/z' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/b' })).toBeInTheDocument()
    expect(linkCalls(client).at(-1)).toEqual({ limit: 50, cursor: '9.l-z' })
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  // A new search after "Load more" starts over from the first page: the pages
  // loaded so far must not survive into a different search's results.
  it('starts over from the first page when a new search is made after Load more', async () => {
    const { user } = show((q) =>
      q.q === 'second'
        ? { items: [link('only')], nextCursor: null }
        : q.cursor === undefined
          ? { items: [link('b'), link('a')], nextCursor: '5.l-a' }
          : { items: [link('z')], nextCursor: null },
    )
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('link', { name: 'go.example.test/z' })
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), 'second')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByRole('link', { name: 'go.example.test/only' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'go.example.test/z' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'go.example.test/b' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'go.example.test/a' })).not.toBeInTheDocument()
  })

  it('says there are no links yet, and says nothing matched a search, differently', async () => {
    show(() => ({ items: [], nextCursor: null }))
    expect(await screen.findByText('No links yet.')).toBeInTheDocument()
  })

  it('says a search matched nothing', async () => {
    show(() => ({ items: [], nextCursor: null }), '/links?q=nothing')
    expect(await screen.findByText('No link matches “nothing”.')).toBeInTheDocument()
  })

  // A page a Load-more click asked for belongs to the search it was clicked
  // under. If a new search starts before that page answers, the answer is for
  // a list no longer on screen and must not join it when it lands.
  it('drops a Load-more page that answers after a new search has already begun', async () => {
    let resolveMore: ((p: Page<Link>) => void) | undefined
    const client = fakeClient({
      links: ((q: Record<string, unknown>) => {
        if (q.q === 'second') return Promise.resolve({ items: [link('only')], nextCursor: null })
        if (q.cursor === undefined)
          return Promise.resolve({ items: [link('b'), link('a')], nextCursor: '5.l-a' })
        return new Promise<Page<Link>>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), 'second')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByRole('link', { name: 'go.example.test/only' })).toBeInTheDocument()
    // The held page answers only now, once the new search is already showing.
    resolveMore?.({ items: [link('z')], nextCursor: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('link', { name: 'go.example.test/z' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/only' })).toBeInTheDocument()
  })

  it('sends only one request for a Load-more click made twice in a row', async () => {
    let resolveMore: ((p: Page<Link>) => void) | undefined
    let moreCalls = 0
    const client = fakeClient({
      links: ((q: Record<string, unknown>) => {
        if (q.cursor === undefined)
          return Promise.resolve({ items: [link('b'), link('a')], nextCursor: '5.l-a' })
        moreCalls += 1
        return new Promise<Page<Link>>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    const button = await screen.findByRole('button', { name: 'Load more' })
    await user.click(button)
    await user.click(button)
    expect(moreCalls).toBe(1)
    resolveMore?.({ items: [link('z')], nextCursor: null })
    expect(await screen.findByRole('link', { name: 'go.example.test/z' })).toBeInTheDocument()
  })

  // While the current search's own first page is still loading, its
  // `nextCursor` on screen is still the previous search's — the button must
  // not be clickable then, or it would ask the new search to continue an old
  // one's page.
  it('disables Load more while the current search is still loading', async () => {
    let resolveSecond: ((p: Page<Link>) => void) | undefined
    let calls = 0
    const client = fakeClient({
      links: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ items: [link('b'), link('a')], nextCursor: '5.l-a' })
        return new Promise<Page<Link>>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    await screen.findByRole('button', { name: 'Load more' })
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), 'x')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled()
    resolveSecond?.({ items: [link('only')], nextCursor: null })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument(),
    )
  })

  // The disabled attribute must already be set the instant the click handler
  // runs — a test that waits first would pass even if only the handler's own
  // guard, not the attribute, stopped the second request.
  it('disables Load more the instant it is clicked', async () => {
    let resolveMore: ((p: Page<Link>) => void) | undefined
    const client = fakeClient({
      links: ((q: Record<string, unknown>) => {
        if (q.cursor === undefined)
          return Promise.resolve({ items: [link('b'), link('a')], nextCursor: '5.l-a' })
        return new Promise<Page<Link>>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    const button = await screen.findByRole('button', { name: 'Load more' })
    await user.click(button)
    expect(button).toBeDisabled()
    resolveMore?.({ items: [], nextCursor: null })
  })

  it('hides the list when a reload fails, rather than leaving stale rows on screen', async () => {
    let calls = 0
    const client = fakeClient({
      links: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve({ items: [link('spring')], nextCursor: null })
        return Promise.reject(new ApiError(500, 'server_error', 'the service is down'))
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    await screen.findByRole('link', { name: 'go.example.test/spring' })
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), 'x')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'go.example.test/spring' })).not.toBeInTheDocument()
  })

  it('marks the list busy while a reload is in flight, without losing it', async () => {
    let resolveSecond: ((p: Page<Link>) => void) | undefined
    let calls = 0
    const client = fakeClient({
      links: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve({ items: [link('spring')], nextCursor: null })
        return new Promise<Page<Link>>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
      domains,
    })
    const { user } = showWith(client)
    const row = await screen.findByRole('link', { name: 'go.example.test/spring' })
    await user.type(screen.getByRole('searchbox', { name: 'Search links' }), 'x')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const busy = row.closest('[aria-busy]')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    resolveSecond?.({ items: [link('spring')], nextCursor: null })
    await waitFor(() => expect(row.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'))
  })

  it('keeps the first page’s rows when Load more’s own request fails', async () => {
    const { user } = show((q) =>
      q.cursor === undefined
        ? { items: [link('b'), link('a')], nextCursor: '5.l-a' }
        : (Promise.reject(new ApiError(500, 'server_error', 'the service is down')) as never),
    )
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/b' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go.example.test/a' })).toBeInTheDocument()
  })

  // Back, or a shared link: the address's own search can change without the
  // box ever being typed in, and the box must still show what the address
  // says, not what it last held.
  it('follows the address’s own search once it changes without the box being typed in', async () => {
    const client = fakeClient({
      links: () => Promise.resolve({ items: [], nextCursor: null }),
      domains,
    })
    render(
      <MemoryRouter initialEntries={['/links?q=first']}>
        <ClientProvider client={client}>
          <RouterLink to="/links?q=second">jump</RouterLink>
          <Routes>
            <Route path="/links" element={<Links />} />
          </Routes>
        </ClientProvider>
      </MemoryRouter>,
    )
    const user = userEvent.setup()
    expect(await screen.findByRole('searchbox', { name: 'Search links' })).toHaveValue('first')
    await user.click(screen.getByRole('link', { name: 'jump' }))
    expect(await screen.findByRole('searchbox', { name: 'Search links' })).toHaveValue('second')
  })
})
