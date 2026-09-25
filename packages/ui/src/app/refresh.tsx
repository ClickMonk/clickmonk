import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

const RefreshContext = createContext<{
  round: number
  refresh: () => void
  refreshing: boolean
  beginLoad: () => void
  endLoad: () => void
}>({
  round: 0,
  refresh: () => {},
  refreshing: false,
  beginLoad: () => {},
  endLoad: () => {},
})

/** How long away before coming back to the tab reloads what is on screen. */
export const FOCUS_REFRESH_AFTER_MS = 60_000

/**
 * One counter every screen's loads depend on. Refresh increments it, and so
 * does coming back to the tab after a minute away — never a timer, because a
 * timer keeps a session alive for as long as a tab is open and spends report
 * slots on a page nobody is reading.
 *
 * `refreshing` is a second, independent counter: how many loads are
 * currently in flight, anywhere on the current screen. `useLoad` calls
 * `beginLoad`/`endLoad` itself around every request it makes, whether that
 * request started from a Refresh press, a window change, a filter or a
 * search, or the screen's own first load — so the Refresh button, which
 * reads `refreshing`, has one true signal for "something is loading" rather
 * than a proxy for one particular load. A failed load still calls `endLoad`,
 * the same as a successful one: only the count of what is still in flight
 * decides the flag, never which of them succeeded.
 */
export function RefreshProvider({
  children,
  now = Date.now,
  focusAfterMs = FOCUS_REFRESH_AFTER_MS,
}: { children: ReactNode; now?: () => number; focusAfterMs?: number }) {
  const [round, setRound] = useState(0)
  const [busy, setBusy] = useState(0)
  const last = useRef(now())
  const refresh = useCallback(() => {
    last.current = now()
    setRound((r) => r + 1)
  }, [now])
  const beginLoad = useCallback(() => setBusy((n) => n + 1), [])
  const endLoad = useCallback(() => setBusy((n) => Math.max(0, n - 1)), [])
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'hidden') return
      if (now() - last.current > focusAfterMs) refresh()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [now, focusAfterMs, refresh])
  const value = useMemo(
    () => ({ round, refresh, refreshing: busy > 0, beginLoad, endLoad }),
    [round, refresh, busy, beginLoad, endLoad],
  )
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
}

export const useRefresh = () => useContext(RefreshContext)
