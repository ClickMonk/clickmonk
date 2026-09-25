import { ApiError } from '@/api/errors'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RefreshProvider, useRefresh } from './refresh'
import { useLoad } from './useLoad'

function Show({ load, dep = 0 }: { load: (s: AbortSignal) => Promise<string>; dep?: number }) {
  const r = useLoad(load, [dep])
  return (
    <div>
      <span data-testid="state">{r.state}</span>
      <span data-testid="data">{r.data ?? ''}</span>
      <span data-testid="error">{r.error?.code ?? ''}</span>
      <button type="button" onClick={r.reload}>
        again
      </button>
    </div>
  )
}

/** Reads the shared `refreshing` flag beside a `Show`, both under one `RefreshProvider`. */
function Busy() {
  const { refreshing } = useRefresh()
  return <p data-testid="busy">{refreshing ? 'busy' : 'idle'}</p>
}

describe('loading', () => {
  it('shows what it loaded', async () => {
    render(<Show load={() => Promise.resolve('numbers')} />)
    expect(await screen.findByText('numbers')).toBeInTheDocument()
    expect(screen.getByTestId('state')).toHaveTextContent('ok')
  })

  it('shows the error it got', async () => {
    render(<Show load={() => Promise.reject(new ApiError(503, 'reporting_unavailable', 'down'))} />)
    expect(await screen.findByText('reporting_unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('state')).toHaveTextContent('error')
  })

  // A screen the operator left, or a window they changed: the answer to the
  // old request must not replace the new one's, and its abort is not an error.
  it('abandons the old request when what it depends on changes, and shows only the new answer', async () => {
    const signals: AbortSignal[] = []
    let finishOld: (v: string) => void = () => {}
    const load = vi.fn((s: AbortSignal) => {
      signals.push(s)
      return signals.length === 1
        ? new Promise<string>((r) => {
            finishOld = r
          })
        : Promise.resolve('new')
    })
    const { rerender } = render(<Show load={load} dep={1} />)
    rerender(<Show load={load} dep={2} />)
    expect(await screen.findByText('new')).toBeInTheDocument()
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => finishOld('old'))
    expect(screen.getByTestId('data')).toHaveTextContent('new')
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })

  // A load that rejects with an abort while its own signal is live — a fetch
  // cancelled by something other than this hook. It is not the service
  // refusing, and it is not shown as one.
  it('does not show an abort it did not cause as an error', async () => {
    render(<Show load={() => Promise.reject(new DOMException('cancelled', 'AbortError'))} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })

  // A load that failed, then what it depends on changes: the new attempt is
  // not the one that failed, and must not be shown as already having failed
  // before it has even answered.
  it('clears a previous failure once a new load — from changed deps — starts', async () => {
    let calls = 0
    const load = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new ApiError(503, 'reporting_unavailable', 'down'))
      return new Promise<string>(() => {})
    })
    const { rerender } = render(<Show load={load} dep={1} />)
    expect(await screen.findByText('reporting_unavailable')).toBeInTheDocument()
    rerender(<Show load={load} dep={2} />)
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })

  // The last success is not "the data" any more once the service has since
  // refused: a reload after a failure must not bring the old answer back
  // while the new attempt is still in flight — a screen that renders on
  // `data` alone (rather than on `state`) would show it as current again.
  it('clears the previous data once a new load starts after a failure', async () => {
    let n = 0
    let resolveThird: (v: string) => void = () => {}
    const load = vi.fn(() => {
      n += 1
      if (n === 1) return Promise.resolve('load 1')
      if (n === 2) return Promise.reject(new ApiError(404, 'not_found', 'no such thing'))
      return new Promise<string>((r) => {
        resolveThird = r
      })
    })
    render(<Show load={load} />)
    expect(await screen.findByText('load 1')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'again' }).click())
    expect(await screen.findByText('not_found')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'again' }).click())
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(screen.getByTestId('data')).toHaveTextContent('')
    expect(screen.getByTestId('error')).toHaveTextContent('')
    await act(async () => resolveThird('load 3'))
  })

  it('loads again when asked, staying in loading with the old data until the new answer arrives', async () => {
    let n = 0
    let resolveSecond: (v: string) => void = () => {}
    const load = vi.fn(() => {
      n += 1
      if (n === 1) return Promise.resolve('load 1')
      return new Promise<string>((r) => {
        resolveSecond = r
      })
    })
    render(<Show load={load} />)
    expect(await screen.findByText('load 1')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'again' }).click())
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(screen.getByTestId('data')).toHaveTextContent('load 1')
    await act(async () => resolveSecond('load 2'))
    expect(screen.getByTestId('state')).toHaveTextContent('ok')
    expect(screen.getByTestId('data')).toHaveTextContent('load 2')
  })

  it('marks the refresh context busy while loading, and clears it once it answers', async () => {
    let resolve: (v: string) => void = () => {}
    render(
      <RefreshProvider>
        <Show
          load={() =>
            new Promise<string>((r) => {
              resolve = r
            })
          }
        />
        <Busy />
      </RefreshProvider>,
    )
    expect(screen.getByTestId('busy')).toHaveTextContent('busy')
    await act(async () => resolve('done'))
    expect(screen.getByTestId('busy')).toHaveTextContent('idle')
  })

  // A refusal is still the load settling: the flag must not read this
  // screen as loading forever after one request the service turned down.
  it('clears the refresh context’s busy flag on a failed load too', async () => {
    let reject: (e: ApiError) => void = () => {}
    render(
      <RefreshProvider>
        <Show
          load={() =>
            new Promise<string>((_resolve, r) => {
              reject = r
            })
          }
        />
        <Busy />
      </RefreshProvider>,
    )
    expect(screen.getByTestId('busy')).toHaveTextContent('busy')
    await act(async () => reject(new ApiError(429, 'rate_limited', 'slow down')))
    expect(screen.getByTestId('busy')).toHaveTextContent('idle')
  })

  // Two loads sharing one context: the flag is a count, not a flag one of
  // them can clear on the other's behalf.
  it('stays busy while a second load is still going after the first of two settles', async () => {
    let resolveFast: (v: string) => void = () => {}
    let resolveSlow: (v: string) => void = () => {}
    render(
      <RefreshProvider>
        <Show
          load={() =>
            new Promise<string>((r) => {
              resolveFast = r
            })
          }
          dep={1}
        />
        <Show
          load={() =>
            new Promise<string>((r) => {
              resolveSlow = r
            })
          }
          dep={2}
        />
        <Busy />
      </RefreshProvider>,
    )
    expect(screen.getByTestId('busy')).toHaveTextContent('busy')
    await act(async () => resolveFast('fast'))
    expect(screen.getByTestId('busy')).toHaveTextContent('busy')
    await act(async () => resolveSlow('slow'))
    expect(screen.getByTestId('busy')).toHaveTextContent('idle')
  })
})
