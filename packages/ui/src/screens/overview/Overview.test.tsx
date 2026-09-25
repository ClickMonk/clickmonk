import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Breakdown, Summary, Timeseries } from '@/api/types'
import { NowProvider } from '@/app/clock'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { Overview } from './Overview'

const NOW = () => Date.parse('2026-10-07T03:00:00.000Z')
const W = { from: '2026-09-30T14:00:00.000Z', to: '2026-10-07T14:00:00.000Z' }

const summary: Summary = {
  window: W,
  link: null,
  clicks: 1200,
  visitors: 830,
  byClass: { human: 900, bot: 250, datacenter: 50 },
  byAction: { '': 900, flag: 280, block: 20 },
  byOutcome: { target: 1180, blocked: 20 },
  newestHour: '2026-10-07T02:00:00.000Z',
}
const series: Timeseries = {
  window: W,
  link: null,
  bucket: 'day',
  // Not the summary's numbers: the chart's table is in the page even while its
  // disclosure is shut, and a bucket equal to the total would be a second match.
  buckets: [{ at: '2026-09-30T14:00:00.000Z', clicks: 1190, visitors: 820 }],
  newestHour: '2026-10-07T02:00:00.000Z',
}
const empty = (dimension: string): Breakdown => ({
  window: W,
  link: null,
  dimension,
  truncated: false,
  rows: [],
})

function show() {
  const client = fakeClient({
    summary: () => Promise.resolve(summary),
    timeseries: () => Promise.resolve(series),
    breakdown: ((_w: unknown, d: string) => Promise.resolve(empty(d))) as never,
  })
  render(
    <NowProvider now={NOW}>
      <MemoryRouter initialEntries={['/overview?range=7d']}>
        <ClientProvider client={client}>
          <Overview />
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
  return client
}

/** `showWith` renders with a caller-built client, for a scenario `show()` can't express. */
function showWith(client: ReturnType<typeof fakeClient>) {
  render(
    <NowProvider now={NOW}>
      <MemoryRouter initialEntries={['/overview?range=7d']}>
        <ClientProvider client={client}>
          <Overview />
        </ClientProvider>
      </MemoryRouter>
    </NowProvider>,
  )
}

describe('the overview', () => {
  it('is titled as a screen, its cards headings under it rather than a second h1', async () => {
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    await screen.findByText('1,200')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0)
  })

  it('shows the five numbers, and says what unique visitors count', async () => {
    show()
    expect(await screen.findByText('1,200')).toBeInTheDocument()
    expect(screen.getByText('830')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('280')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(
      screen.getByText(/Unique visitors count what a cookie can see: traffic that keeps no cookie/),
    ).toBeInTheDocument()
  })

  it('asks for the operator’s seven days, charted by the day from where their days begin', async () => {
    const client = show()
    await screen.findByText('1,200')
    const ts = client.calls.find((c) => c.method === 'timeseries')
    expect(ts?.args.slice(0, 3)).toEqual([
      { from: '2026-09-30T14:30:00.000Z', to: '2026-10-07T03:00:00.000Z' },
      'day',
      10,
    ])
  })

  it('asks for a summary, a chart and eight breakdowns, and nothing else', async () => {
    const client = show()
    await screen.findByText('1,200')
    await new Promise((r) => setTimeout(r, 0))
    expect(
      client.calls
        .map((c) => (c.method === 'breakdown' ? `breakdown ${c.args[1]}` : c.method))
        .sort(),
    ).toEqual([
      'breakdown browser',
      'breakdown class',
      'breakdown country',
      'breakdown device',
      'breakdown link',
      'breakdown os',
      'breakdown outcome',
      'breakdown referrer',
      'summary',
      'timeseries',
    ])
  })

  // Twice: once for the numbers and once under the chart, because the two can
  // differ — the chart's days align to the offset, the summary to the hour —
  // and here they happen to agree.
  it('shows the window the service counted', async () => {
    show()
    expect(
      await screen.findAllByText('Counted 30 Sept, 23:30 – 8 Oct, 00:30 (Australia/Adelaide)'),
    ).toHaveLength(2)
  })

  it('plots the visitors themselves once switched, having said nothing of the caution under clicks', async () => {
    show()
    await screen.findByText('1,200')
    // Absent under clicks, first: the caution is about the visitors metric
    // only, and must not already be on screen before it is switched to.
    expect(screen.queryByText(/Visitors are counted per bar/)).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Visitors' }))
    expect(
      await screen.findByText(
        'Visitors are counted per bar; adding bars together counts a returning visitor more than once.',
      ),
    ).toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Show the numbers'))
    expect(screen.getByText('820')).toBeInTheDocument()
    expect(screen.queryByText('1,190')).not.toBeInTheDocument()
  })

  it('writes the chart’s own numbers to a CSV', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob)
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    show()
    await screen.findByText('1,200')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download the chart as CSV' }))
    expect(await created[0]?.text()).toBe(
      '"Bucket start (UTC)","Label","Clicks","Visitors"\r\n"2026-09-30T14:00:00.000Z","Thu 1 Oct","1190","820"\r\n',
    )
  })

  it('asks again, with the new window’s dates, when the range changes', async () => {
    const client = show()
    await screen.findByText('1,200')
    await new Promise((r) => setTimeout(r, 0))
    const before = client.calls.filter((c) => c.method === 'breakdown').length
    await userEvent.setup().selectOptions(screen.getByLabelText('Time range'), '30d')
    await new Promise((r) => setTimeout(r, 0))
    const breakdownCalls = client.calls.filter((c) => c.method === 'breakdown')
    expect(breakdownCalls.length).toBe(before + 8)
    const newFroms = new Set(
      breakdownCalls.slice(-8).map((c) => (c.args[0] as { from: string }).from),
    )
    expect([...newFroms]).toEqual(['2026-09-07T14:30:00.000Z'])
  })

  // Nothing checks that Report actually calls the day-labeller rather than
  // labelling each bucket plainly: a 7-day range's own bucket is 'day', so
  // the response saying 'hour' (which happens; the two are independent) is
  // also what proves the card title follows the answer, not the request.
  it('carries the day on every hour label once the chart spans more than one local date, and titles the card by the response’s own bucket', async () => {
    const hourly: Timeseries = {
      window: W,
      link: null,
      bucket: 'hour',
      buckets: Array.from({ length: 30 }, (_, i) => ({
        at: new Date(Date.parse('2026-10-07T00:00:00.000Z') + i * 3_600_000).toISOString(),
        clicks: i,
        visitors: i,
      })),
      newestHour: '2026-10-07T02:00:00.000Z',
    }
    showWith(
      fakeClient({
        summary: () => Promise.resolve(summary),
        timeseries: () => Promise.resolve(hourly),
        breakdown: ((_w: unknown, d: string) => Promise.resolve(empty(d))) as never,
      }),
    )
    await screen.findByText('1,200')
    expect(screen.getByText('By hour')).toBeInTheDocument()
    expect(screen.queryByText('By day')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Show the numbers'))
    const table = within(screen.getByRole('table'))
    expect(table.getByText('Wed 7 Oct, 10:30')).toBeInTheDocument()
    expect(table.getByText('Thu 8 Oct, 10:30')).toBeInTheDocument()
  })

  // The summary answering before the breakdowns is common, but the reverse
  // can happen too: a breakdown's own request lands while the summary it
  // shares a total with is still on the window before. The share must wait
  // for both, not just its own panel's load.
  it('shows a breakdown’s share only once the summary for the same window has answered too', async () => {
    let resolveSecondSummary: ((s: Summary) => void) | undefined
    let summaryCalls = 0
    const countryAnswer: Breakdown = {
      window: W,
      link: null,
      dimension: 'country',
      truncated: false,
      rows: [{ value: 'DE', clicks: 7, visitors: 3 }],
    }
    showWith(
      fakeClient({
        summary: () => {
          summaryCalls += 1
          if (summaryCalls === 1) return Promise.resolve(summary)
          return new Promise<Summary>((resolve) => {
            resolveSecondSummary = resolve
          })
        },
        timeseries: () => Promise.resolve(series),
        breakdown: ((_w: unknown, d: string) =>
          Promise.resolve(d === 'country' ? countryAnswer : empty(d))) as never,
      }),
    )
    expect(await screen.findByText('7 · <1%')).toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByLabelText('Time range'), '30d')
    await new Promise((r) => setTimeout(r, 0))
    // The country panel's own breakdown has already answered for the new
    // window (it resolves at once), but the summary has not: no share.
    expect(screen.getByText('Germany')).toBeInTheDocument()
    expect(screen.queryByText(/7 · /)).not.toBeInTheDocument()
    resolveSecondSummary?.({ ...summary, clicks: 20 })
    expect(await screen.findByText('7 · 35%')).toBeInTheDocument()
  })

  it('hides the old summary numbers when a new window’s summary request fails', async () => {
    let summaryCalls = 0
    showWith(
      fakeClient({
        summary: () => {
          summaryCalls += 1
          if (summaryCalls === 1) return Promise.resolve(summary)
          return Promise.reject(
            new ApiError(503, 'reporting_unavailable', 'reporting is not available'),
          )
        },
        timeseries: () => Promise.resolve(series),
        breakdown: ((_w: unknown, d: string) => Promise.resolve(empty(d))) as never,
      }),
    )
    expect(await screen.findByText('1,200')).toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByLabelText('Time range'), '30d')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('1,200')).not.toBeInTheDocument()
  })

  it('hides the old chart when a new window’s timeseries request fails', async () => {
    let seriesCalls = 0
    showWith(
      fakeClient({
        summary: () => Promise.resolve(summary),
        timeseries: () => {
          seriesCalls += 1
          if (seriesCalls === 1) return Promise.resolve(series)
          return Promise.reject(
            new ApiError(503, 'reporting_unavailable', 'reporting is not available'),
          )
        },
        breakdown: ((_w: unknown, d: string) => Promise.resolve(empty(d))) as never,
      }),
    )
    await screen.findByText('1,200')
    expect(screen.getByRole('img')).toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByLabelText('Time range'), '30d')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('hides the chart’s CSV button while a reload is in flight', async () => {
    let resolveSecondSeries: ((t: Timeseries) => void) | undefined
    let seriesCalls = 0
    showWith(
      fakeClient({
        summary: () => Promise.resolve(summary),
        timeseries: () => {
          seriesCalls += 1
          if (seriesCalls === 1) return Promise.resolve(series)
          return new Promise<Timeseries>((resolve) => {
            resolveSecondSeries = resolve
          })
        },
        breakdown: ((_w: unknown, d: string) => Promise.resolve(empty(d))) as never,
      }),
    )
    expect(
      await screen.findByRole('button', { name: 'Download the chart as CSV' }),
    ).toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByLabelText('Time range'), '30d')
    expect(
      screen.queryByRole('button', { name: 'Download the chart as CSV' }),
    ).not.toBeInTheDocument()
    resolveSecondSeries?.(series)
    expect(
      await screen.findByRole('button', { name: 'Download the chart as CSV' }),
    ).toBeInTheDocument()
  })
})
