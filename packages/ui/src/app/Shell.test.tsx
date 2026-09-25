import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { RefreshProvider } from './refresh'

const STATUS = {
  newestHour: null,
  reporting: 'ok',
  ipData: null,
  ipDataProblem: null,
  alerts: 0,
} as const

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
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(client.calls.filter((c) => c.method === 'status')).toHaveLength(2))
  })
})
