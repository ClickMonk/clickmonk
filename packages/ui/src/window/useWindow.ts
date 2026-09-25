import { browserZone, useNow } from '@/app/clock'
import { useRefresh } from '@/app/refresh'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { type Choice, bucketFor, choiceParams, dayOffsetHours, parseChoice, spanOf } from './range'

/**
 * The window the current address names, in the operator's zone.
 *
 * "Now" is read when the choice changes and on every refresh round — not on
 * every render, and not on a timer: a window that crept forward by itself would
 * change the numbers under the operator while they read them, and would ask
 * for reports nobody requested.
 */
export function useWindow() {
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const { choice, problem } = parseChoice(params)
  const key = JSON.stringify(choice)
  const [refreshedAt, setRefreshedAt] = useState(() => now())
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setRefreshedAt(now())
  }
  // A refresh — the button, or coming back to the tab — moves "now" too, so
  // "Today" and "Last 7 days" end at the moment of the refresh rather than at
  // the moment the screen was opened.
  const { round } = useRefresh()
  const [lastRound, setLastRound] = useState(round)
  if (round !== lastRound) {
    setLastRound(round)
    setRefreshedAt(now())
  }
  const timeZone = useMemo(browserZone, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `choice` is a new object every render; `key` is its value, so the span is recomputed only when the choice itself changes.
  const span = useMemo(() => spanOf(choice, refreshedAt, timeZone), [key, refreshedAt, timeZone])
  const setChoice = useCallback(
    (c: Choice) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const k of ['range', 'from', 'to']) next.delete(k)
        for (const [k, v] of Object.entries(choiceParams(c))) next.set(k, v)
        return next
      })
    },
    [setParams],
  )
  const refresh = useCallback(() => setRefreshedAt(now()), [now])
  return {
    choice,
    setChoice,
    span,
    bucket: bucketFor(span),
    offset: dayOffsetHours(span, timeZone),
    timeZone,
    problem,
    refresh,
    refreshedAt,
  }
}
