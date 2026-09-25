import { ApiError } from '@/api/errors'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
})
