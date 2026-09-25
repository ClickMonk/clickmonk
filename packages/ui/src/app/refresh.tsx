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

const RefreshContext = createContext<{ round: number; refresh: () => void }>({
  round: 0,
  refresh: () => {},
})

/** How long away before coming back to the tab reloads what is on screen. */
export const FOCUS_REFRESH_AFTER_MS = 60_000

/**
 * One counter every screen's loads depend on. Refresh increments it, and so
 * does coming back to the tab after a minute away — never a timer, because a
 * timer keeps a session alive for as long as a tab is open and spends report
 * slots on a page nobody is reading.
 */
export function RefreshProvider({
  children,
  now = Date.now,
  focusAfterMs = FOCUS_REFRESH_AFTER_MS,
}: { children: ReactNode; now?: () => number; focusAfterMs?: number }) {
  const [round, setRound] = useState(0)
  const last = useRef(now())
  const refresh = useCallback(() => {
    last.current = now()
    setRound((r) => r + 1)
  }, [now])
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
  const value = useMemo(() => ({ round, refresh }), [round, refresh])
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
}

export const useRefresh = () => useContext(RefreshContext)
