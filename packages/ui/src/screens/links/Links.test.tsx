import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import type { Domain, Link, Page } from '@/api/types'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
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

function show(pages: (q: Record<string, unknown>) => Page<Link>, at = '/links') {
  const client = fakeClient({
    links: ((q: Record<string, unknown>) => Promise.resolve(pages(q))) as never,
    domains: () =>
      Promise.resolve({
        domains: [domain('go.example.test', true), domain('new.example.test', false)],
        truncated: false,
      }),
  })
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
})
