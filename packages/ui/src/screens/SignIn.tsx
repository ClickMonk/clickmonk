import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { SignIn as SignInBody } from '@/api/types'
import { ErrorNote } from '@/app/ErrorNote'
import { ThemeToggle } from '@/app/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type FormEvent, useRef, useState } from 'react'

/**
 * Signing in. The password first; the second factor only when the service
 * answers `totp_required`, and then the same request again with the code added
 * — which is how the service is built: one route, called once or twice. A
 * wrong answer keeps the email and clears the secrets.
 *
 * One request at a time, whatever the button is pressed: the guard is a ref
 * rather than the disabled state, because a second click can land before the
 * render that disables the button.
 */
export function SignIn({
  onSignedIn,
  ended,
  notKept = false,
}: { onSignedIn: () => void; ended: boolean; notKept?: boolean }) {
  const client = useClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [factor, setFactor] = useState<'none' | 'code' | 'recovery'>('none')
  const [code, setCode] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const body: SignInBody = { email, password }
    if (factor === 'code') body.code = code
    if (factor === 'recovery') body.recoveryCode = code
    try {
      await client.signIn(body)
      onSignedIn()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      if (err.code === 'totp_required' && factor === 'none') {
        setFactor('code')
      } else {
        setError(err)
        setPassword('')
        setCode('')
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-sm content-center gap-6 px-4">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-foreground">Sign in</h1>
        <ThemeToggle />
      </div>
      {ended && (
        <output className="block text-sm text-muted-foreground">
          Your session ended. Sign in again.
        </output>
      )}
      {/* The service accepted the password, but the browser handed back no
          cookie on the check that followed — the sign in the operator just
          did did not stick. Distinct from a session that ended: nothing here
          had ever been signed in. The usual cause is an `https`-only cookie
          on a page opened over plain `http`. */}
      {!ended && notKept && (
        <output className="block text-sm text-muted-foreground">
          Signed in, but this browser did not keep the session. ClickMonk has to be opened over
          https.
        </output>
      )}
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {factor !== 'none' && (
          <div className="grid gap-1">
            <Label htmlFor="code">
              {factor === 'code' ? 'Code from your authenticator app' : 'Recovery code'}
            </Label>
            <Input
              id="code"
              autoComplete="one-time-code"
              inputMode={factor === 'code' ? 'numeric' : 'text'}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button
              type="button"
              variant="link"
              className="justify-self-start px-0"
              onClick={() => {
                setFactor(factor === 'code' ? 'recovery' : 'code')
                setCode('')
              }}
            >
              {factor === 'code'
                ? 'Use a recovery code instead'
                : 'Use a code from the app instead'}
            </Button>
          </div>
        )}
        {error && <ErrorNote error={error} />}
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
      {/* The service answers a sign-in to an install with no account exactly as
          it answers a wrong password, on purpose: a stranger must not learn the
          account is unclaimed. So the way to make one is said here, where a
          first-time operator is, and it says nothing the README does not. */}
      <p className="text-xs text-muted-foreground">
        No account yet? It is created on the server with clickmonk admin create — the README shows
        the command.
      </p>
    </main>
  )
}
