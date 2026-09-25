import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import { MIN_ADMIN_PASSWORD_LENGTH } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type FormEvent, useState } from 'react'

/** "1 other session was" against "2 other sessions were" — the count is never off by the word around it. */
function signedOutSentence(count: number): string {
  const session = count === 1 ? 'session' : 'sessions'
  const was = count === 1 ? 'was' : 'were'
  return `Password changed. ${count} other ${session} ${was} signed out.`
}

/**
 * Changing the password. The service signs out every other session when it
 * does, and says how many; that count is the only thing this shows on
 * success, because "Saved" would hide the part that matters. `onChanged`
 * lets `Account` reload the sessions list, which the service has just
 * shortened.
 */
export function Password({ onChanged = () => {} }: { onChanged?: () => void } = {}) {
  const client = useClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [again, setAgain] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A failure that is not an `ApiError` is a defect, not a refusal to show,
  // and is rethrown to React the way `Confirm` does.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setStatus(null)
    setFailure(null)
    setCurrentPasswordError(null)
    if (newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      setProblem(`A password is at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== again) {
      setProblem('The two new passwords are not the same.')
      return
    }
    setProblem(null)
    setBusy(true)
    void (async () => {
      try {
        const r = await client.changePassword({ currentPassword, newPassword })
        setStatus(signedOutSentence(r.otherSessionsSignedOut))
        setCurrentPassword('')
        setNewPassword('')
        setAgain('')
        onChanged()
      } catch (err) {
        if (!(err instanceof ApiError)) {
          setThrown(err)
        } else if (err.code === 'invalid_password') {
          setCurrentPasswordError(err.message)
        } else {
          setFailure(err)
        }
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section aria-labelledby="password-heading" className="grid gap-4">
      <h2 id="password-heading" className="font-serif text-lg font-semibold text-foreground">
        Password
      </h2>
      <form className="grid max-w-sm gap-4" onSubmit={submit} noValidate>
        <div className="grid gap-1">
          <Label htmlFor="current-password">Current password</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            aria-invalid={currentPasswordError ? true : undefined}
            aria-describedby={currentPasswordError ? 'current-password-error' : undefined}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          {currentPasswordError && (
            <p id="current-password-error" className="text-sm text-destructive">
              {currentPasswordError}
            </p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="new-password-again">New password again</Label>
          <Input
            id="new-password-again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {failure && <ErrorNote error={failure} />}
        <Button type="submit" disabled={busy} className="justify-self-start">
          Change password
        </Button>
        {status && <output className="block text-sm text-muted-foreground">{status}</output>}
      </form>
    </section>
  )
}
