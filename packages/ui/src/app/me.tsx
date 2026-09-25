import type { Me } from '@/api/types'
import { type ReactNode, createContext, useContext } from 'react'

const MeContext = createContext<{ me: Me; refreshMe: () => Promise<void> } | null>(null)

/**
 * The signed-in admin, and how to re-read it from the service. Its own
 * module because `App` imports the router and the router imports `Account`;
 * a context defined in `App.tsx` would close that loop.
 */
export function MeProvider({
  me,
  refreshMe,
  children,
}: { me: Me; refreshMe: () => Promise<void>; children: ReactNode }) {
  return <MeContext.Provider value={{ me, refreshMe }}>{children}</MeContext.Provider>
}

/** The account this browser is signed in as. A screen rendered outside a provider is a defect, said loudly. */
export function useMe(): { me: Me; refreshMe: () => Promise<void> } {
  const c = useContext(MeContext)
  if (c === null) throw new Error('useMe outside a MeProvider')
  return c
}
