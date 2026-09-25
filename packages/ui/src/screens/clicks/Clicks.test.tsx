import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Click, ClickCount, ClickPage } from '@/api/types'
import { NowProvider } from '@/app/clock'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Clicks } from './Clicks'

const NOW = () => Date.parse('2026-10-07T03:00:00.000Z')
const W = { from: '2026-10-06T13:30:00.000Z', to: '2026-10-07T03:00:00.000Z' }

const click = (id: string, over: Partial<Click> = {}): Click => ({
  clickId: id,
  at: '2026-10-07T02:15:00.000Z',
  host: 'go.example.test',
  path: '/spring',
  domainId: 'd1',
  linkId: '00000000-0000-4000-8000-0000000000a1',
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/offer',
  targetId: 't1',
  visitorId: 'v-123',
  returning: false,
  country: 'DE',
  region: null,
  city: null,
  geoSource: 'dbip',
  device: 'desktop',
  os: 'windows',
  browser: 'chrome',
  asn: 64500,
  class: 'human',
  signals: [],
  action: null,
  referrer: 'https://blog.example.com/post',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
  network: '198.51.100.0/24',
  capUnchecked: false,
  ...over,
})

/**
 * Renders the screen. Either builds a client from the common fixtures
 * (`pages`, `count`), or — for a scenario those can't express (a lookup that
 * fails, a page held on a deferred promise, per-call routing) — takes a
 * caller-built one directly via `client`, which then ignores `pages`/`count`.
 */
function show(
  o: {
    client?: ReturnType<typeof fakeClient>
    pages?: (cursor?: string) => ClickPage
    count?: ClickCount
    at?: string
  } = {},
) {
  const client =
    o.client ??
    fakeClient({
      clicks: ((_f: unknown, page: { cursor?: string }) =>
        Promise.resolve(
          o.pages
            ? o.pages(page.cursor)
            : { window: W, link: null, clicks: [click('c1')], nextCursor: null },
        )) as never,
      clickCount: () =>
        Promise.resolve(
          o.count ?? { window: W, link: null, count: 3, cap: 1_000_000, truncated: false },
        ),
      link: () =>
        Promise.resolve({
          id: '00000000-0000-4000-8000-0000000000a1',
          host: 'go.example.test',
          slug: 'spring',
          name: 'Spring offer',
        } as never),
    })
  render(
    <NowProvider now={NOW}>
      <MemoryRouter initialEntries={[o.at ?? '/clicks?range=today']}>
        <ClientProvider client={client}>
          <Clicks />
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
  return { client, user: userEvent.setup() }
}

const clickCalls = (client: ReturnType<typeof fakeClient>) =>
  client.calls.filter((c) => c.method === 'clicks').map((c) => c.args.slice(0, 2))

describe('the click log', () => {
  it('is titled as a screen', () => {
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Clicks' })).toBeInTheDocument()
  })

  it('says exactly why the log and the reports can disagree', () => {
    show()
    expect(
      screen.getByText(
        'Every click, newest first. The log counts the window to the millisecond; the reports count whole hours, so the two can differ by the clicks in a partial hour.',
      ),
    ).toBeInTheDocument()
  })

  it('asks for the exact window and fifty clicks', async () => {
    const { client } = show()
    await screen.findByText('Germany')
    expect(clickCalls(client)).toEqual([[W, { limit: 50 }]])
  })

  it('shows each click as the operator reads it, the address as a network', async () => {
    show()
    const row = (await screen.findByText('Germany')).closest('tr') as HTMLElement
    expect(within(row).getByText('7 Oct 2026, 12:45')).toBeInTheDocument()
    expect(within(row).getByText('go.example.test/spring')).toBeInTheDocument()
    expect(within(row).getByText('Sent to a target')).toBeInTheDocument()
    expect(within(row).getByText('Human')).toBeInTheDocument()
    expect(within(row).getByText('198.51.100.0/24')).toBeInTheDocument()
  })

  it('shows a blanked address as blanked', async () => {
    show({
      pages: () => ({
        window: W,
        link: null,
        clicks: [click('c1', { network: null })],
        nextCursor: null,
      }),
    })
    expect(await screen.findByTitle('Blanked or not recorded')).toHaveTextContent('—')
  })

  it('shows every field of a click on request', async () => {
    const { user } = show()
    await user.click(await screen.findByRole('button', { name: 'Show every field of this click' }))
    expect(screen.getByText('Mozilla/5.0 (Windows NT 10.0) Chrome/130')).toBeInTheDocument()
    expect(screen.getByText('c1')).toBeInTheDocument()
    // Which target rotation chose, and the ids — fields the row does not show.
    expect(screen.getByText('t1')).toBeInTheDocument()
    expect(screen.getByText('00000000-0000-4000-8000-0000000000a1')).toBeInTheDocument()
  })

  it('filters by class, keeps the filter in the address, and starts again from the first page', async () => {
    const { client, user } = show()
    await screen.findByText('Germany')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'bot')
    await screen.findByText('Germany')
    expect(clickCalls(client).at(-1)).toEqual([{ ...W, class: 'bot' }, { limit: 50 }])
  })

  it('filters by the link in the address, and names it', async () => {
    const { client } = show({ at: '/clicks?range=today&link=00000000-0000-4000-8000-0000000000a1' })
    expect(
      await screen.findByText('Link: go.example.test/spring — Spring offer'),
    ).toBeInTheDocument()
    expect(clickCalls(client).at(-1)?.[0]).toEqual({
      ...W,
      link: '00000000-0000-4000-8000-0000000000a1',
    })
  })

  // A lookup that fails, is slow, or simply hasn't answered yet must not
  // leave the log silently filtered with nothing on screen saying so, and
  // must not strand the operator without a way to clear it.
  it('still offers to clear the link filter when the link lookup fails', async () => {
    const client = fakeClient({
      clicks: () =>
        Promise.resolve({
          window: W,
          link: null,
          clicks: [click('c1')],
          nextCursor: null,
        } as never),
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.reject(new ApiError(500, 'server_error', 'the service is down')),
    })
    const { client: c, user } = show({
      client,
      at: '/clicks?range=today&link=00000000-0000-4000-8000-0000000000a1',
    })
    expect(await screen.findByText('Link filter applied')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear the link filter' }))
    expect(clickCalls(c).at(-1)?.[0]).toEqual(W)
  })

  it('clears the link filter from a link that did resolve, and asks again without it', async () => {
    const { client, user } = show({
      at: '/clicks?range=today&link=00000000-0000-4000-8000-0000000000a1',
    })
    await screen.findByText('Link: go.example.test/spring — Spring offer')
    await user.click(screen.getByRole('button', { name: 'Clear the link filter' }))
    expect(
      screen.queryByText('Link: go.example.test/spring — Spring offer'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear the link filter' })).not.toBeInTheDocument()
    expect(clickCalls(client).at(-1)?.[0]).toEqual(W)
  })

  it('filters by outcome, keeps the filter in the address, and starts again from the first page', async () => {
    const { client, user } = show()
    await screen.findByText('Germany')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'blocked')
    await screen.findByText('Germany')
    expect(clickCalls(client).at(-1)).toEqual([{ ...W, outcome: 'blocked' }, { limit: 50 }])
  })

  it('upper-cases a typed country and applies it on blur', async () => {
    const { client, user } = show()
    await screen.findByText('Germany')
    await user.type(screen.getByLabelText('Country'), 'de')
    await user.tab()
    expect(clickCalls(client).at(-1)).toEqual([{ ...W, country: 'DE' }, { limit: 50 }])
    expect(screen.getByLabelText('Country')).toHaveValue('DE')
  })

  // The country field is checked locally, the way the window's own custom
  // range is: a value the service would refuse is never written to the
  // address at all, and the field says why beside itself instead.
  it('refuses a country that is not two letters, without writing it to the address', async () => {
    const { client, user } = show()
    await screen.findByText('Germany')
    const input = screen.getByLabelText('Country')
    await user.type(input, 'D')
    await user.tab()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('A country is two letters.')).toBeInTheDocument()
    expect(clickCalls(client)).toEqual([[W, { limit: 50 }]])
  })

  it('says a filter in the address could not be used', () => {
    show({ at: '/clicks?range=today&class=robot' })
    expect(
      screen.getByText('A filter in this address could not be used and was left out.'),
    ).toBeInTheDocument()
  })

  it('shows a boolean field as Yes or No, not true or false', async () => {
    const { user } = show({
      pages: () => ({
        window: W,
        link: null,
        clicks: [click('c1', { returning: true, capUnchecked: false })],
        nextCursor: null,
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Show every field of this click' }))
    const returning = screen.getByText('Returning').nextElementSibling
    const capUnchecked = screen.getByText('Cap not checked').nextElementSibling
    expect(returning).toHaveTextContent('Yes')
    expect(capUnchecked).toHaveTextContent('No')
    expect(screen.queryByText('true')).not.toBeInTheDocument()
    expect(screen.queryByText('false')).not.toBeInTheDocument()
  })

  it('loads the next page after the one shown', async () => {
    const { client, user } = show({
      pages: (cursor) =>
        cursor === undefined
          ? { window: W, link: null, clicks: [click('c2')], nextCursor: '1759800000000.c2' }
          : { window: W, link: null, clicks: [click('c1', { country: 'FR' })], nextCursor: null },
    })
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('France')).toBeInTheDocument()
    expect(screen.getByText('Germany')).toBeInTheDocument()
    expect(clickCalls(client).at(-1)).toEqual([W, { limit: 50, cursor: '1759800000000.c2' }])
  })

  it('says a window with no clicks is empty', async () => {
    show({ pages: () => ({ window: W, link: null, clicks: [], nextCursor: null }) })
    expect(await screen.findByText('No clicks in this window.')).toBeInTheDocument()
  })

  it('dims the table and marks it busy while a reload is in flight, rather than blanking it', async () => {
    let resolveSecond: ((p: ClickPage) => void) | undefined
    let calls = 0
    const client = fakeClient({
      clicks: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ window: W, link: null, clicks: [click('c1')], nextCursor: null })
        return new Promise<ClickPage>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client })
    const row = (await screen.findByText('Germany')).closest('tr') as HTMLElement
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'bot')
    const busy = row.closest('[aria-busy]')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveClass('opacity-50')
    resolveSecond?.({ window: W, link: null, clicks: [click('c1')], nextCursor: null })
    await waitFor(() => expect(row.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'))
  })

  it('hides the table when a reload fails, rather than leaving stale rows on screen', async () => {
    let calls = 0
    const client = fakeClient({
      clicks: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ window: W, link: null, clicks: [click('c1')], nextCursor: null })
        return Promise.reject(new ApiError(500, 'server_error', 'the service is down'))
      }) as never,
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client })
    await screen.findByText('Germany')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'bot')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Germany')).not.toBeInTheDocument()
  })

  // A page already appended by "Load more" belongs to the filters it was
  // fetched under. Changing a filter afterwards must drop it, the same way a
  // new search drops an old page in the link list.
  it('drops the appended page when a filter changes after Load more has finished', async () => {
    const { user } = show({
      pages: (cursor) =>
        cursor === undefined
          ? { window: W, link: null, clicks: [click('c2')], nextCursor: '1759800000000.c2' }
          : { window: W, link: null, clicks: [click('c1', { country: 'FR' })], nextCursor: null },
    })
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('France')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'bot')
    await screen.findByText('Germany')
    expect(screen.queryByText('France')).not.toBeInTheDocument()
  })

  // A page a Load-more click asked for belongs to the filters it was clicked
  // under. If those change before the page answers, the answer describes a
  // query no longer on screen and must not join it when it lands.
  it('drops a Load-more page that answers after a filter has already changed', async () => {
    let resolveMore: ((p: ClickPage) => void) | undefined
    const client = fakeClient({
      clicks: ((f: { class?: string }, page: { cursor?: string }) => {
        if (f.class === 'bot')
          return Promise.resolve({ window: W, link: null, clicks: [click('c1')], nextCursor: null })
        if (page.cursor === undefined)
          return Promise.resolve({
            window: W,
            link: null,
            clicks: [click('c2')],
            nextCursor: '1759800000000.c2',
          })
        return new Promise<ClickPage>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client })
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'bot')
    await screen.findByText('Germany')
    // The held page answers only now, once the new filter is already showing.
    resolveMore?.({
      window: W,
      link: null,
      clicks: [click('c1', { country: 'FR' })],
      nextCursor: null,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('France')).not.toBeInTheDocument()
    expect(screen.getByText('Germany')).toBeInTheDocument()
  })

  it('sends only one request for a Load-more click made twice in a row', async () => {
    let resolveMore: ((p: ClickPage) => void) | undefined
    let moreCalls = 0
    const client = fakeClient({
      clicks: ((_f: unknown, page: { cursor?: string }) => {
        if (page.cursor === undefined)
          return Promise.resolve({
            window: W,
            link: null,
            clicks: [click('c2')],
            nextCursor: '1759800000000.c2',
          })
        moreCalls += 1
        return new Promise<ClickPage>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client })
    const button = await screen.findByRole('button', { name: 'Load more' })
    await user.click(button)
    await user.click(button)
    expect(moreCalls).toBe(1)
    resolveMore?.({
      window: W,
      link: null,
      clicks: [click('c1', { country: 'FR' })],
      nextCursor: null,
    })
    expect(await screen.findByText('France')).toBeInTheDocument()
  })

  // The disabled attribute must already be set the instant the click handler
  // runs — a test that waits first would pass even if only the handler's own
  // guard, not the attribute, stopped the second request.
  it('disables Load more the instant it is clicked', async () => {
    let resolveMore: ((p: ClickPage) => void) | undefined
    const client = fakeClient({
      clicks: ((_f: unknown, page: { cursor?: string }) => {
        if (page.cursor === undefined)
          return Promise.resolve({
            window: W,
            link: null,
            clicks: [click('c2')],
            nextCursor: '1759800000000.c2',
          })
        return new Promise<ClickPage>((resolve) => {
          resolveMore = resolve
        })
      }) as never,
      clickCount: () =>
        Promise.resolve({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false }),
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client })
    const button = await screen.findByRole('button', { name: 'Load more' })
    await user.click(button)
    expect(button).toBeDisabled()
    resolveMore?.({ window: W, link: null, clicks: [], nextCursor: null })
  })
})

describe('the export', () => {
  it('counts first, then offers the file with the same filters', async () => {
    const { client, user } = show({ at: '/clicks?range=today&class=bot' })
    await user.click(await screen.findByRole('button', { name: 'Export as CSV' }))
    expect(await screen.findByText('3 clicks will be in the file.')).toBeInTheDocument()
    expect(client.calls.find((c) => c.method === 'clickCount')?.args[0]).toEqual({
      ...W,
      class: 'bot',
    })
    expect(screen.getByRole('link', { name: 'Download the CSV' })).toHaveAttribute(
      'href',
      '/api/clicks.csv?from=2026-10-06T13%3A30%3A00.000Z&to=2026-10-07T03%3A00%3A00.000Z&class=bot',
    )
  })

  // A window holding more than the cap. The operator reads where the file will
  // stop before it starts, and how to get the rest.
  it('says before the download that the file will stop at the cap', async () => {
    const { user } = show({
      count: { window: W, link: null, count: 1_000_000, cap: 1_000_000, truncated: true },
    })
    await user.click(await screen.findByRole('button', { name: 'Export as CSV' }))
    expect(
      await screen.findByText(
        'This window holds more than 1,000,000 clicks. The file stops at 1,000,000, newest first; choose a shorter window for the rest.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download the first 1,000,000' })).toBeInTheDocument()
  })

  it('says there is nothing to export, and offers no link, when the count is zero', async () => {
    const { user } = show({
      count: { window: W, link: null, count: 0, cap: 1_000_000, truncated: false },
    })
    await user.click(await screen.findByRole('button', { name: 'Export as CSV' }))
    expect(
      await screen.findByText('There are no clicks to export in this window.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('clears the count and the link when a filter changes after counting', async () => {
    const { user } = show({ at: '/clicks?range=today&class=bot' })
    await user.click(await screen.findByRole('button', { name: 'Export as CSV' }))
    expect(await screen.findByText('3 clicks will be in the file.')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'human')
    expect(screen.queryByText('3 clicks will be in the file.')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Download the CSV' })).not.toBeInTheDocument()
  })

  // A count asked for under one filter must not appear once the operator has
  // already moved on to another — it names a file that is no longer the one
  // "Download the CSV" would offer.
  it('never shows a count that answers after the filter it was asked under has changed', async () => {
    let resolveCount: ((c: ClickCount) => void) | undefined
    const client = fakeClient({
      clicks: () =>
        Promise.resolve({
          window: W,
          link: null,
          clicks: [click('c1')],
          nextCursor: null,
        } as never),
      clickCount: (() => {
        return new Promise<ClickCount>((resolve) => {
          resolveCount = resolve
        })
      }) as never,
      link: () => Promise.resolve(null as never),
    })
    const { user } = show({ client, at: '/clicks?range=today&class=bot' })
    await user.click(await screen.findByRole('button', { name: 'Export as CSV' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Traffic class' }), 'human')
    resolveCount?.({ window: W, link: null, count: 3, cap: 1_000_000, truncated: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('3 clicks will be in the file.')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Download the CSV' })).not.toBeInTheDocument()
  })
})
