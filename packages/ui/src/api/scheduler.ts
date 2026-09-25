/**
 * Report requests, two at a time.
 *
 * The admin service runs two report queries at once per process and answers a
 * third with 429 and `retry-after: 1`. The overview alone asks for ten. So the
 * interface queues its own report requests, in the order they were asked for,
 * and holds at most as many in flight as the server will run. A second tab, or
 * a script, can still take a slot, which is what the retry is for: a 429 for a
 * report is waited out for as long as the server says, up to three times,
 * before it is shown to anyone.
 *
 * A request whose signal is aborted while it waits is dropped without being
 * sent — a screen the operator has left should not spend a slot the next screen
 * needs. One already sent is the fetch's to cancel, not this.
 */
import { ApiError } from './errors'

export const REPORTS_IN_FLIGHT = 2
export const REPORT_RETRIES = 3

export interface Scheduler {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

const abortError = (): DOMException => new DOMException('the request was abandoned', 'AbortError')

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createScheduler(
  o: { limit?: number; retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Scheduler {
  const limit = o.limit ?? REPORTS_IN_FLIGHT
  const retries = o.retries ?? REPORT_RETRIES
  const sleep = o.sleep ?? wait
  let running = 0
  const queue: (() => void)[] = []

  const next = (): void => {
    while (running < limit && queue.length > 0) queue.shift()?.()
  }

  async function attempt<T>(task: () => Promise<T>): Promise<T> {
    for (let tried = 0; ; tried++) {
      try {
        return await task()
      } catch (err) {
        const busy =
          err instanceof ApiError && err.status === 429 && err.code === 'too_many_reports'
        if (!busy || tried >= retries) throw err
        await sleep((err.retryAfterSeconds ?? 1) * 1000)
      }
    }
  }

  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          if (signal?.aborted) {
            reject(abortError())
            next()
            return
          }
          running += 1
          attempt(task)
            .then(resolve, reject)
            .finally(() => {
              running -= 1
              next()
            })
        }
        queue.push(start)
        next()
      })
    },
  }
}
