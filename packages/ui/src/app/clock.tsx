import { type ReactNode, createContext, useContext } from 'react'

const NowContext = createContext<() => number>(() => Date.now())

/** The clock the interface reads "now" from. A test gives it a fixed one. */
export function NowProvider({ now, children }: { now: () => number; children: ReactNode }) {
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>
}

export const useNow = (): (() => number) => useContext(NowContext)
export const useNowMs = (): number => useContext(NowContext)()

/** The browser's own zone. Every time the interface shows is in it. */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
