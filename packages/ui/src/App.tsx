import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ApiClient, createClient } from './api/client'
import { ClientProvider } from './api/context'
import { ApiError } from './api/errors'
import type { Me } from './api/types'
import { AppRoutes } from './app/Router'
import { Shell } from './app/Shell'
import { MeProvider } from './app/me'
import { RefreshProvider } from './app/refresh'
import { NoAdmin } from './screens/NoAdmin'
import { SignIn } from './screens/SignIn'
import { Unavailable } from './screens/Unavailable'

type Phase =
  | { name: 'checking' }
  | { name: 'unavailable'; error: ApiError }
  | { name: 'no_admin' }
  | { name: 'anonymous'; ended: boolean; notKept: boolean }
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
    setPhase((p) =>
      p.name === 'authenticated' ? { name: 'anonymous', ended: true, notKept: false } : p,
    )
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: one client for the life of the page
  const client = useMemo(() => makeClient(ended), [])

  // The same request, run at boot and again right after a sign-in. Only the
  // second case can mean the browser refused to keep the session cookie (an
  // `https`-only cookie handed to a plain `http` page): the boot case, and a
  // retry from Unavailable, get no special wording because nothing was just
  // signed in for the session to have failed to keep.
  const runCheck = useCallback(
    async (unauthenticatedNotice: 'none' | 'not_kept') => {
      setPhase({ name: 'checking' })
      try {
        const me = await client.me({ signal: AbortSignal.timeout(bootTimeoutMs) })
        setPhase({ name: 'authenticated', me })
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        if (err.status === 401)
          setPhase({
            name: 'anonymous',
            ended: false,
            notKept: unauthenticatedNotice === 'not_kept',
          })
        else if (err.status === 503 && err.code === 'no_admin') setPhase({ name: 'no_admin' })
        else setPhase({ name: 'unavailable', error: err })
      }
    },
    [client, bootTimeoutMs],
  )
  const check = useCallback(() => runCheck('none'), [runCheck])
  const afterSignIn = useCallback(() => runCheck('not_kept'), [runCheck])

  useEffect(() => {
    void check()
  }, [check])

  const signOut = useCallback(async () => {
    try {
      await client.signOut()
    } catch {
      // Signed out either way: a session the service already ended is not a reason to stay.
    }
    setPhase({ name: 'anonymous', ended: false, notKept: false })
  }, [client])

  // Re-reads the account after a change on the account screen (enrolling or
  // turning off two-factor, replacing recovery codes) so that screen shows
  // what the service now says, not what it said at boot.
  const refreshMe = useCallback(async () => {
    setPhase({ name: 'authenticated', me: await client.me() })
  }, [client])

  return (
    <ClientProvider client={client}>
      {phase.name === 'checking' && <div className="min-h-dvh bg-background" />}
      {phase.name === 'unavailable' && <Unavailable error={phase.error} onRetry={check} />}
      {phase.name === 'no_admin' && <NoAdmin />}
      {phase.name === 'anonymous' && (
        <SignIn ended={phase.ended} notKept={phase.notKept} onSignedIn={afterSignIn} />
      )}
      {phase.name === 'authenticated' && (
        <RefreshProvider>
          <MeProvider me={phase.me} refreshMe={refreshMe}>
            <Shell email={phase.me.email} onSignOut={signOut}>
              <AppRoutes />
            </Shell>
          </MeProvider>
        </RefreshProvider>
      )}
    </ClientProvider>
  )
}
