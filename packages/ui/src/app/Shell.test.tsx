import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { RefreshProvider } from './refresh'
import { useLoad } from './useLoad'

const STATUS = {
  newestHour: null,
  reporting: 'ok',
  ipData: null,
  ipDataProblem: null,
  alerts: 0,
} as const

/** A stand-in for a screen's own load, so a test can control it independently of Freshness's. */
function Loader({
  id = 'load',
  load,
  dep = 0,
}: {
  id?: string
  load: (signal: AbortSignal) => Promise<string>
  dep?: number
}) {
  const r = useLoad(load, [dep])
  return <p>{`${id}: ${r.state}`}</p>
}

function show(at = '/links') {
  const client = fakeClient({ status: () => Promise.resolve(STATUS) })
  render(
    <MemoryRouter initialEntries={[at]}>
      <ClientProvider client={client}>
        <RefreshProvider>
          <Shell email="admin@example.com" onSignOut={() => {}}>
            <p>screen</p>
          </Shell>
        </RefreshProvider>
      </ClientProvider>
    </MemoryRouter>,
  )
  return client
}

/** Renders Shell with a caller-built client and children, for scenarios `show()` can't express. */
function showWith(client: ReturnType<typeof fakeClient>, children: ReactNode) {
  render(
    <MemoryRouter initialEntries={['/links']}>
      <ClientProvider client={client}>
        <RefreshProvider>
          <Shell email="admin@example.com" onSignOut={() => {}}>
            {children}
          </Shell>
        </RefreshProvider>
      </ClientProvider>
    </MemoryRouter>,
  )
}

describe('the shell', () => {
  it('links every screen and marks the one that is open', () => {
    show('/links')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')])
    expect(names).toEqual([
      ['Overview', '/overview'],
      ['Links', '/links'],
      ['Clicks', '/clicks'],
      ['Domains', '/domains'],
      ['Settings', '/settings'],
      ['Account', '/account'],
    ])
    expect(within(nav).getByRole('link', { name: 'Links' })).toHaveAttribute('aria-current', 'page')
  })

  // The active item's fill against the nav's own sunken background is the
  // only visual cue that it is current — aria-current reaches assistive
  // technology alone — so it has to be the strong accent fill, not the pale
  // accent-surface tint that barely differs from the nav behind it.
  it('marks the open screen with the strong accent fill, not a pale tint', () => {
    show('/links')
    const active = screen.getByRole('link', { name: 'Links' })
    expect(active).toHaveClass('bg-primary', 'text-primary-foreground')
    expect(active).not.toHaveClass('bg-accent', 'text-accent-foreground')
  })

  it('names the zone times are shown in', () => {
    show()
    expect(screen.getByText('Times in Australia/Adelaide')).toBeInTheDocument()
  })

  it('credits the IP data as its licence requires', () => {
    show()
    const credit = screen.getByRole('contentinfo')
    expect(within(credit).getByRole('link', { name: 'DB-IP' })).toHaveAttribute(
      'href',
      'https://db-ip.com',
    )
    expect(within(credit).getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    )
    expect(credit).toHaveTextContent(
      'IP geolocation by DB-IP, licensed under CC BY 4.0. ClickMonk converts it to its own lookup format.',
    )
  })

  it('reloads what is on screen when Refresh is pressed', async () => {
    const client = show()
    await screen.findByText('No clicks have reached the reports yet.')
    const button = await screen.findByRole('button', { name: 'Refresh' })
    await userEvent.setup().click(button)
    await waitFor(() => expect(client.calls.filter((c) => c.method === 'status')).toHaveLength(2))
  })

  // Refreshing is one true signal for "something on this screen is loading",
  // not a proxy for one particular request — a round is the simplest case of
  // it, driven the same way every other load is.
  it('shows Refreshing… and disables itself while a round is in flight', async () => {
    let resolveSecond: ((s: typeof STATUS) => void) | undefined
    let calls = 0
    const client = fakeClient({
      status: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(STATUS)
        return new Promise<typeof STATUS>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
    })
    showWith(client, <p>screen</p>)
    await screen.findByText('No clicks have reached the reports yet.')
    const button = await screen.findByRole('button', { name: 'Refresh' })
    await userEvent.setup().click(button)
    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    resolveSecond?.(STATUS)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
  })

  // The dimmed content it replaced was itself a contrast failure; the button
  // base fades every disabled control to disabled:opacity-50, so this state
  // needs its own override rather than inheriting that fade.
  it('draws Refreshing… at full contrast, not the disabled fade', async () => {
    let resolveSecond: ((s: typeof STATUS) => void) | undefined
    let calls = 0
    const client = fakeClient({
      status: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(STATUS)
        return new Promise<typeof STATUS>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
    })
    showWith(client, <p>screen</p>)
    await screen.findByText('No clicks have reached the reports yet.')
    const button = await screen.findByRole('button', { name: 'Refresh' })
    await userEvent.setup().click(button)
    const refreshing = await screen.findByRole('button', { name: 'Refreshing…' })
    expect(refreshing).not.toHaveClass('disabled:opacity-50')
    expect(refreshing).toHaveClass('disabled:opacity-100')
    resolveSecond?.(STATUS)
  })

  // A 429 or any other refusal is still a load settling, not a load that
  // never happened: it must release the button the same as a success does.
  it('re-enables Refresh once a failed reload settles, not only a successful one', async () => {
    let rejectSecond: ((err: ApiError) => void) | undefined
    let calls = 0
    const client = fakeClient({
      status: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(STATUS)
        return new Promise<typeof STATUS>((_resolve, reject) => {
          rejectSecond = reject
        })
      }) as never,
    })
    showWith(client, <p>screen</p>)
    await screen.findByText('No clicks have reached the reports yet.')
    const button = await screen.findByRole('button', { name: 'Refresh' })
    await userEvent.setup().click(button)
    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    rejectSecond?.(new ApiError(429, 'rate_limited', 'slow down'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
  })

  // #46's proxy read only Freshness's own load; a slower report load left the
  // button re-enabled while the numbers under it were still on the old
  // window. The flag now has to outlast whichever load on the screen is
  // slowest, not just the one in the header.
  it('keeps Refreshing… when a slower load is still going after the status load has answered', async () => {
    const client = fakeClient({ status: () => Promise.resolve(STATUS) })
    let resolveReport: ((v: string) => void) | undefined
    const report = () =>
      new Promise<string>((resolve) => {
        resolveReport = resolve
      })
    showWith(client, <Loader id="report" load={report} />)
    await screen.findByText('No clicks have reached the reports yet.')
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    resolveReport?.('done')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
  })

  // A window change, a filter or a search never touches `round`: they change
  // a screen's own load deps instead. The button has to answer to that too,
  // not only to a press of Refresh.
  it('shows Refreshing… when a load restarts from something other than Refresh, such as a window change', async () => {
    const client = fakeClient({ status: () => Promise.resolve(STATUS) })
    let calls = 0
    let resolveSecond: ((v: string) => void) | undefined
    const load = () => {
      calls += 1
      if (calls === 1) return Promise.resolve('first')
      return new Promise<string>((resolve) => {
        resolveSecond = resolve
      })
    }
    const tree = (dep: number) => (
      <MemoryRouter initialEntries={['/links']}>
        <ClientProvider client={client}>
          <RefreshProvider>
            <Shell email="admin@example.com" onSignOut={() => {}}>
              <Loader load={load} dep={dep} />
            </Shell>
          </RefreshProvider>
        </ClientProvider>
      </MemoryRouter>
    )
    const { rerender } = render(tree(1))
    await screen.findByText('No clicks have reached the reports yet.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
    rerender(tree(2))
    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    resolveSecond?.('second')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
  })

  // A load that fails must clear only its own slot: the button stays down
  // until the slowest of them settles, whatever any one of them answered.
  it('does not re-enable Refresh while one load is still going, even once another has failed', async () => {
    const client = fakeClient({ status: () => Promise.resolve(STATUS) })
    let resolveSlow: ((v: string) => void) | undefined
    const failing = () => Promise.reject(new ApiError(429, 'rate_limited', 'slow down'))
    const slow = () =>
      new Promise<string>((resolve) => {
        resolveSlow = resolve
      })
    showWith(
      client,
      <>
        <Loader id="failing" load={failing} />
        <Loader id="slow" load={slow} />
      </>,
    )
    await screen.findByText('No clicks have reached the reports yet.')
    await screen.findByText('failing: error')
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    resolveSlow?.('done')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
  })
})
