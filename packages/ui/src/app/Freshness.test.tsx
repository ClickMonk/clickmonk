import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import type { Status } from '@/api/types'
import { NowProvider } from '@/app/clock'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Freshness } from './Freshness'

const NOW = () => Date.parse('2026-10-07T03:10:00.000Z')
const base: Status = {
  newestHour: null,
  reporting: 'ok',
  ipData: null,
  ipDataProblem: null,
  alerts: 0,
}

function show(status: Status) {
  render(
    <NowProvider now={NOW}>
      <MemoryRouter>
        <ClientProvider client={fakeClient({ status: () => Promise.resolve(status) })}>
          <Freshness />
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
}

describe('how fresh the numbers are', () => {
  it('names the newest hour the reports hold, in local time', async () => {
    show({ ...base, newestHour: '2026-10-07T02:00:00.000Z' })
    expect(
      await screen.findByText('Reports include clicks up to 7 Oct 2026, 12:30–13:30.'),
    ).toBeInTheDocument()
  })

  it('says when nothing has been recorded yet', async () => {
    show(base)
    expect(await screen.findByText('No clicks have reached the reports yet.')).toBeInTheDocument()
  })

  it('says when reporting is down', async () => {
    show({ ...base, reporting: 'unavailable' })
    expect(
      await screen.findByText('Reporting is unavailable: ClickMonk cannot reach its click store.'),
    ).toBeInTheDocument()
  })

  it('says how old the oldest IP list is', async () => {
    show({
      ...base,
      ipData: {
        country: { version: '2026-10', fetchedAt: '2026-10-05T03:10:00.000Z' },
        asn: { version: '2026-10', fetchedAt: '2026-10-06T03:10:00.000Z' },
        datacenter: null,
        tor: { version: 'x', fetchedAt: '2026-10-07T02:10:00.000Z' },
      },
    })
    expect(
      await screen.findByText('IP lists updated 2 days ago; hosting networks never fetched.'),
    ).toBeInTheDocument()
  })

  it('says there is no IP data, and what that means', async () => {
    show(base)
    expect(
      await screen.findByText(
        'No IP data: countries and networks are unknown, and clicks are classed unknown rather than human.',
      ),
    ).toBeInTheDocument()
  })

  it('says the IP data could not be read', async () => {
    show({ ...base, ipDataProblem: 'the IP data manifest could not be read' })
    expect(await screen.findByText('The IP data could not be read.')).toBeInTheDocument()
  })

  it('says nothing when no domain needs attention', async () => {
    show({ ...base, alerts: 0 })
    // Wait for the status to have rendered before asserting an absence, so
    // this cannot pass merely because nothing has loaded yet.
    await screen.findByText('No clicks have reached the reports yet.')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('names one domain in the singular', async () => {
    show({ ...base, alerts: 1 })
    expect(
      await screen.findByRole('link', { name: '1 domain needs attention' }),
    ).toBeInTheDocument()
  })

  it('links to the domains that need attention', async () => {
    show({ ...base, alerts: 2 })
    const link = await screen.findByRole('link', { name: '2 domains need attention' })
    expect(link).toHaveAttribute('href', '/domains')
  })

  it('counts past five hundred as five hundred and more', async () => {
    show({ ...base, alerts: 501 })
    expect(
      await screen.findByRole('link', { name: '500+ domains need attention' }),
    ).toBeInTheDocument()
  })

  it('writes exactly five hundred as 500, not 500+', async () => {
    show({ ...base, alerts: 500 })
    expect(
      await screen.findByRole('link', { name: '500 domains need attention' }),
    ).toBeInTheDocument()
  })
})
