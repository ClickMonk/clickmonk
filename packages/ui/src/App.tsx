import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ApiClient, createClient } from './api/client'
import { ClientProvider } from './api/context'
import { ApiError } from './api/errors'
import type { Me } from './api/types'
import { AppRoutes } from './app/Router'
import { Shell } from './app/Shell'
import { RefreshProvider } from './app/refresh'
import { NoAdmin } from './screens/NoAdmin'
import { SignIn } from './screens/SignIn'
import { Unavailable } from './screens/Unavailable'

type Phase =
  | { name: 'checking' }
  | { name: 'unavailable'; error: ApiError }
  | { name: 'no_admin' }
  | { name: 'anonymous'; ended: boolean }
  | { name: 'authenticated'; me: Me }

export const BOOT_TIMEOUT_MS = 8000

/**
 * What the operator sees before any screen. One client for the life of the
 * page, whose `onUnauthorized` is the only way a 401 changes the phase: a
 * session that ended is a state of the whole interface, not an error in one
 * panel, and the second and later 401s find the phase already anonymous.
 */
export function App({
  makeClient = (onUnauthorized) => createClient({ onUnauthorized }),
  bootTimeoutMs = BOOT_TIMEOUT_MS,
}: { makeClient?: (onUnauthorized: () => void) => ApiClient; bootTimeoutMs?: number }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' })
  const ended = useCallback(() => {
    setPhase((p) => (p.name === 'authenticated' ? { name: 'anonymous', ended: true } : p))
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: one client for the life of the page
  const client = useMemo(() => makeClient(ended), [])

  const check = useCallback(async () => {
    setPhase({ name: 'checking' })
    try {
      const me = await client.me({ signal: AbortSignal.timeout(bootTimeoutMs) })
      setPhase({ name: 'authenticated', me })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      if (err.status === 401) setPhase({ name: 'anonymous', ended: false })
      else if (err.status === 503 && err.code === 'no_admin') setPhase({ name: 'no_admin' })
      else setPhase({ name: 'unavailable', error: err })
    }
  }, [client, bootTimeoutMs])

  useEffect(() => {
    void check()
  }, [check])

  const signOut = useCallback(async () => {
    try {
      await client.signOut()
    } catch {
      // Signed out either way: a session the service already ended is not a reason to stay.
    }
    setPhase({ name: 'anonymous', ended: false })
  }, [client])

  return (
    <ClientProvider client={client}>
      {phase.name === 'checking' && <div className="min-h-dvh bg-background" />}
      {phase.name === 'unavailable' && <Unavailable error={phase.error} onRetry={check} />}
      {phase.name === 'no_admin' && <NoAdmin />}
      {phase.name === 'anonymous' && <SignIn ended={phase.ended} onSignedIn={check} />}
      {phase.name === 'authenticated' && (
        <RefreshProvider>
          <Shell email={phase.me.email} onSignOut={signOut}>
            <AppRoutes />
          </Shell>
        </RefreshProvider>
      )}
    </ClientProvider>
  )
}
