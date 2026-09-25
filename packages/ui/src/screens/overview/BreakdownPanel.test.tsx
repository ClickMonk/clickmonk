import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Breakdown } from '@/api/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BreakdownPanel } from './BreakdownPanel'

const W = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }

const answer = (rows: Breakdown['rows'], truncated = false): Breakdown => ({
  window: W,
  link: null,
  dimension: 'country',
  truncated,
  rows,
})

function show(breakdown: (...a: unknown[]) => Promise<Breakdown>) {
  const client = fakeClient({ breakdown: breakdown as never })
  render(
    <ClientProvider client={client}>
      <BreakdownPanel query={W} dimension="country" total={10} round={0} />
    </ClientProvider>,
  )
  return client
}

describe('a breakdown panel', () => {
  it('names each value, and gives its clicks and share of the total', async () => {
    show(() =>
      Promise.resolve(
        answer([
          { value: 'DE', clicks: 7, visitors: 3 },
          { value: '', clicks: 3, visitors: 3 },
        ]),
      ),
    )
    expect(await screen.findByText('Germany')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('7 · 70%')).toBeInTheDocument()
  })

  it('asks for ten, and for a hundred on Show all, and says when the list was cut', async () => {
    const client = show((_w, _d, limit) =>
      Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }], limit === 10)),
    )
    expect(await screen.findByText('Top 10 shown.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }))
    expect(await screen.findByText('Germany')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'breakdown').map((c) => c.args[2])).toEqual([
      10, 100,
    ])
  })

  it('says a window with nothing in it is empty', async () => {
    show(() => Promise.resolve(answer([])))
    expect(await screen.findByText('Nothing in this window.')).toBeInTheDocument()
  })

  it('says its own failure without taking the screen with it', async () => {
    show(() =>
      Promise.reject(new ApiError(503, 'reporting_unavailable', 'reporting is not available')),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reporting is not available right now',
    )
  })

  it('writes what it shows to a CSV', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob)
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // jsdom cannot navigate, and says so on the console when a link is
    // followed; the click is what matters, so it is counted rather than run.
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    show(() => Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }])))
    await screen.findByText('Germany')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download countries as CSV' }))
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(await created[0]?.text()).toBe(
      '"Country","Code","Clicks","Visitors"\r\n"Germany","DE","7","3"\r\n',
    )
  })
})
