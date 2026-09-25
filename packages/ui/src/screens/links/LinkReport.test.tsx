import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Breakdown, Link } from '@/api/types'
import { NowProvider } from '@/app/clock'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
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

function show(link: () => Promise<Link>) {
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
})
