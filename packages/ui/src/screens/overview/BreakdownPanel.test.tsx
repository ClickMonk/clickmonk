import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Breakdown } from '@/api/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BreakdownPanel } from './BreakdownPanel'

const W = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }
const W2 = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' }

const answer = (rows: Breakdown['rows'], truncated = false): Breakdown => ({
  window: W,
  link: null,
  dimension: 'country',
  truncated,
  rows,
})

function show(breakdown: (...a: unknown[]) => Promise<Breakdown>, total = 20) {
  const client = fakeClient({ breakdown: breakdown as never })
  const view = render(
    <ClientProvider client={client}>
      <BreakdownPanel query={W} dimension="country" total={total} round={0} />
    </ClientProvider>,
  )
  return { client, ...view }
}

describe('a breakdown panel', () => {
  it('names each value, and gives its clicks and share of the total', async () => {
    // The total (20) is not the rows' own sum (10): a share computed from the
    // rows themselves rather than the total this panel was given would still
    // read 70% here, and pass by accident.
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
    expect(screen.getByText('7 · 35%')).toBeInTheDocument()
  })

  it('asks for ten, and for a hundred on Show all, and says when the list was cut', async () => {
    const { client } = show((_w, _d, limit) =>
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

  it('names a link’s CSV column by its id, not "Code"', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob)
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const client = fakeClient({
      breakdown: (() =>
        Promise.resolve({
          window: W,
          link: null,
          dimension: 'link',
          truncated: false,
          rows: [
            {
              value: 'a1',
              clicks: 4,
              visitors: 2,
              link: { slug: 'spring', host: 'go.example.test', name: null },
            },
          ],
        })) as never,
    })
    render(
      <ClientProvider client={client}>
        <BreakdownPanel query={W} dimension="link" total={20} round={0} />
      </ClientProvider>,
    )
    await screen.findByText('go.example.test/spring')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download links as CSV' }))
    expect(await created[0]?.text()).toBe(
      '"Link","Link ID","Clicks","Visitors"\r\n"go.example.test/spring","a1","4","2"\r\n',
    )
  })

  // "Show all" is a choice about the window it was pressed in. A new window
  // starts back at the top ten rather than silently asking the new window
  // for a hundred rows nobody chose to see there.
  it('resets to the top ten when the window changes, even after Show all', async () => {
    const { client, rerender } = show(() =>
      Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }], true)),
    )
    await screen.findByText('Top 10 shown.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }))
    await screen.findByText('Germany')
    rerender(
      <ClientProvider client={client}>
        <BreakdownPanel query={W2} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    await screen.findByText('Top 10 shown.')
    expect(client.calls.filter((c) => c.method === 'breakdown').map((c) => c.args[2])).toEqual([
      10, 100, 10,
    ])
  })

  // The old window's rows sitting next to the new window's error would read
  // as though they were still current. A failed reload drops them.
  it('drops the old rows when the new window’s request fails', async () => {
    let calls = 0
    const client = fakeClient({
      breakdown: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }]))
        return Promise.reject(
          new ApiError(503, 'reporting_unavailable', 'reporting is not available'),
        )
      }) as never,
    })
    const { rerender } = render(
      <ClientProvider client={client}>
        <BreakdownPanel query={W} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(await screen.findByText('Germany')).toBeInTheDocument()
    rerender(
      <ClientProvider client={client}>
        <BreakdownPanel query={W2} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Germany')).not.toBeInTheDocument()
  })

  // While a reload is in flight the old rows stay up, marked busy and dimmed,
  // rather than blanking the panel on every window change or refresh.
  it('marks the panel busy and dims the rows while a reload is in flight, without losing them', async () => {
    let resolveSecond: ((b: Breakdown) => void) | undefined
    let calls = 0
    const client = fakeClient({
      breakdown: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }]))
        return new Promise<Breakdown>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
    })
    const { rerender } = render(
      <ClientProvider client={client}>
        <BreakdownPanel query={W} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(await screen.findByText('Germany')).toBeInTheDocument()
    const region = screen.getByText('Germany').closest('[aria-busy]') as HTMLElement
    expect(region).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('rows')).not.toHaveClass('opacity-50')
    rerender(
      <ClientProvider client={client}>
        <BreakdownPanel query={W2} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Germany')).toBeInTheDocument()
    expect(screen.getByTestId('rows')).toHaveClass('opacity-50')
    resolveSecond?.(answer([{ value: 'FR', clicks: 5, visitors: 2 }]))
    expect(await screen.findByText('France')).toBeInTheDocument()
    expect(region).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('rows')).not.toHaveClass('opacity-50')
  })

  // The CSV a panel offers while stale would write the previous window's
  // rows under the new window's file name; simplest is to offer no CSV at
  // all until this panel's own answer has landed.
  it('hides the CSV button while a reload is in flight', async () => {
    let resolveSecond: ((b: Breakdown) => void) | undefined
    let calls = 0
    const client = fakeClient({
      breakdown: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }]))
        return new Promise<Breakdown>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
    })
    const { rerender } = render(
      <ClientProvider client={client}>
        <BreakdownPanel query={W} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(
      await screen.findByRole('button', { name: 'Download countries as CSV' }),
    ).toBeInTheDocument()
    rerender(
      <ClientProvider client={client}>
        <BreakdownPanel query={W2} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(
      screen.queryByRole('button', { name: 'Download countries as CSV' }),
    ).not.toBeInTheDocument()
    resolveSecond?.(answer([{ value: 'FR', clicks: 5, visitors: 2 }]))
    expect(
      await screen.findByRole('button', { name: 'Download countries as CSV' }),
    ).toBeInTheDocument()
  })

  // Reproduces the exact numbers a re-render with a pending new query and a
  // new total once showed: the old row (7 clicks) briefly read "7 · 14%"
  // (against the *new* total of 50) before this panel's own answer for that
  // window had come back. The share must not appear until it does.
  it('shows a share only once its own answer matches the total it is shown against', async () => {
    let resolveSecond: ((b: Breakdown) => void) | undefined
    let calls = 0
    const client = fakeClient({
      breakdown: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve(answer([{ value: 'DE', clicks: 7, visitors: 3 }]))
        return new Promise<Breakdown>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
    })
    const { rerender } = render(
      <ClientProvider client={client}>
        <BreakdownPanel query={W} dimension="country" total={20} round={0} />
      </ClientProvider>,
    )
    expect(await screen.findByText('7 · 35%')).toBeInTheDocument()
    rerender(
      <ClientProvider client={client}>
        <BreakdownPanel query={W2} dimension="country" total={50} round={0} />
      </ClientProvider>,
    )
    // Still the old (dimmed) row, but no share computed against the new
    // total while this panel's own load has not caught up with it.
    expect(screen.getByText('Germany')).toBeInTheDocument()
    expect(screen.queryByText('7 · 35%')).not.toBeInTheDocument()
    expect(screen.queryByText('7 · 14%')).not.toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    resolveSecond?.(answer([{ value: 'DE', clicks: 7, visitors: 3 }]))
    expect(await screen.findByText('7 · 14%')).toBeInTheDocument()
  })
})
