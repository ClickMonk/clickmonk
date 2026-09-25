import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './errors'
import { createScheduler } from './scheduler'

/** A promise and the two functions that settle it, so a test decides when a request answers. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const busy = () => new ApiError(429, 'too_many_reports', 'too many reports at once; try again', 1)
const noWait = () => Promise.resolve()

describe('the report scheduler', () => {
  it('holds two requests in flight and queues the rest, in order', async () => {
    const s = createScheduler({ sleep: noWait })
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()]
    const started: number[] = []
    const results = gates.map((g, i) =>
      s.run(() => {
        started.push(i)
        return g.promise
      }),
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[1]?.resolve('b')
    await results[1]
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])
    gates[0]?.resolve('a')
    await results[0]
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])
    gates[2]?.resolve('c')
    gates[3]?.resolve('d')
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
  })

  // The overview on a busy install: the server answers "too many reports"
  // twice and then the numbers. The operator must see the numbers.
  it('waits out a busy server and retries, as many times as it says to wait', async () => {
    const sleep = vi.fn(noWait)
    const s = createScheduler({ sleep })
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('numbers')
    expect(await s.run(task)).toBe('numbers')
    expect(task).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[1000], [1000]])
  })

  it('waits as long as the server says, not a second whatever it says', async () => {
    const sleep = vi.fn(noWait)
    const s = createScheduler({ sleep })
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(429, 'too_many_reports', 'busy', 3))
      .mockResolvedValueOnce('ok')
    await s.run(task)
    expect(sleep.mock.calls).toEqual([[3000]])
  })

  it('gives up after three retries and says why', async () => {
    const s = createScheduler({ sleep: noWait })
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(busy())
    await expect(s.run(task)).rejects.toMatchObject({ status: 429, code: 'too_many_reports' })
    expect(task).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['another refusal', new ApiError(429, 'too_many_exports', 'an export is already running', 1)],
    ['a bad request', new ApiError(400, 'invalid_query', 'to: must be after from')],
    ['an outage', new ApiError(503, 'reporting_unavailable', 'reporting is not available')],
  ])('does not retry %s', async (_label, error) => {
    const s = createScheduler({ sleep: noWait })
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    await expect(s.run(task)).rejects.toBe(error)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('gives the slot back when a request fails', async () => {
    const s = createScheduler({ limit: 1, sleep: noWait })
    await expect(s.run(() => Promise.reject(new ApiError(400, 'x', 'x')))).rejects.toBeInstanceOf(
      ApiError,
    )
    expect(await s.run(() => Promise.resolve('next'))).toBe('next')
  })

  // A screen the operator left: its queued requests are dropped without being
  // sent, and the ones behind them move up.
  it('never sends a request that was abandoned while it waited', async () => {
    const s = createScheduler({ limit: 1, sleep: noWait })
    const first = deferred<string>()
    const running = s.run(() => first.promise)
    const abandoned = new AbortController()
    const never = vi.fn(() => Promise.resolve('sent'))
    const dropped = s.run(never, abandoned.signal)
    const after = s.run(() => Promise.resolve('after'))
    abandoned.abort()
    first.resolve('first')
    await running
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' })
    expect(await after).toBe('after')
    expect(never).not.toHaveBeenCalled()
  })

  // Refused at once, even with every slot taken: it is not queued to wait for
  // a turn it will never use.
  it('refuses a request abandoned before it was asked for, without waiting for a slot', async () => {
    const s = createScheduler({ limit: 1, sleep: noWait })
    void s.run(() => new Promise<string>(() => {}))
    const gone = new AbortController()
    gone.abort()
    const task = vi.fn(() => Promise.resolve('x'))
    await expect(s.run(task, gone.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()
  })
})
