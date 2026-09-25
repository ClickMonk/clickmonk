import { ApiError } from '@/api/errors'
import { useCallback, useEffect, useState } from 'react'

type Loaded<T> = {
  state: 'loading' | 'ok' | 'error'
  data: T | undefined
  error: ApiError | undefined
}

/**
 * One request's life on a screen: loading, then the answer or the error.
 *
 * Each load gets its own signal, aborted when what it depends on changes or the
 * screen goes away, so an answer to a request nobody is waiting for can never
 * replace the one that is — the window changed from 7 days to 30, and the
 * 7-day answer arrives second. An abort is not an error and is never shown.
 * An error that is not an `ApiError` is a defect in this package and is
 * rethrown to React rather than shown as a service's refusal.
 *
 * The previous data stays visible while a reload is in flight, so Refresh does
 * not blank the screen. The previous error does not: a load that starts is a
 * fresh attempt, and showing the last one's failure while this one is still
 * running would blame the wrong request once it succeeds. A load that starts
 * after a failure has no previous answer to hold onto either — the last
 * success is not "the data" any more once the service has since refused, so a
 * reload after an error goes back to loading with nothing shown, the same as
 * a screen's first load.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [loaded, setLoaded] = useState<Loaded<T>>({
    state: 'loading',
    data: undefined,
    error: undefined,
  })
  const [round, setRound] = useState(0)
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's list of what this load reads; `load` is a new function every render and must not be one.
  useEffect(() => {
    const controller = new AbortController()
    setLoaded((l) => ({
      state: 'loading',
      data: l.state === 'error' ? undefined : l.data,
      error: undefined,
    }))
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoaded({ state: 'ok', data, error: undefined })
      },
      (err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (err instanceof ApiError)
          setLoaded((l) => ({ state: 'error', data: l.data, error: err }))
        else setThrown(err)
      },
    )
    return () => controller.abort()
  }, [...deps, round])

  const reload = useCallback(() => setRound((r) => r + 1), [])
  return { ...loaded, reload }
}
