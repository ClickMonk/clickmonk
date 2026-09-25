import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import { CopyButton } from '@/app/CopyButton'
import { ErrorNote } from '@/app/ErrorNote'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/ui/modal'
import { type FormEvent, useState } from 'react'
import { TotpQr } from './TotpQr'

type Factor = { kind: 'code'; code: string } | { kind: 'recovery'; recoveryCode: string }

const factorBody = (f: Factor): { code: string } | { recoveryCode: string } =>
  f.kind === 'code' ? { code: f.code } : { recoveryCode: f.recoveryCode }

/**
 * An empty attempt refused before it is sent: the service treats `code: ''`
 * as a guess and counts it against the lockout, the same as a wrong one.
 */
const factorProblem = (f: Factor): string | null => {
  if (f.kind === 'code') return f.code === '' ? 'Enter the code from the app.' : null
  return f.recoveryCode === '' ? 'Enter the recovery code.' : null
}

const emptyFactor: Factor = { kind: 'code', code: '' }

type SetupStep =
  | { name: 'password'; password: string }
  | { name: 'confirm'; password: string; secret: string; uri: string; code: string }

const emptySetup: SetupStep = { name: 'password', password: '' }

/**
 * The password, plus — once a second factor exists — a code from the app or a
 * recovery code, never both. Follows `SignIn`'s pattern of a toggle between
 * the two.
 */
function SecondFactorFields({
  idPrefix,
  password,
  setPassword,
  factor,
  setFactor,
}: {
  idPrefix: string
  password: string
  setPassword: (v: string) => void
  factor: Factor
  setFactor: (f: Factor) => void
}) {
  return (
    <>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-password`}>Your password</Label>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-factor`}>
          {factor.kind === 'code' ? 'Code from the app' : 'Recovery code'}
        </Label>
        <Input
          id={`${idPrefix}-factor`}
          type="text"
          inputMode={factor.kind === 'code' ? 'numeric' : 'text'}
          autoComplete="one-time-code"
          value={factor.kind === 'code' ? factor.code : factor.recoveryCode}
          onChange={(e) =>
            setFactor(
              factor.kind === 'code'
                ? { kind: 'code', code: e.target.value }
                : { kind: 'recovery', recoveryCode: e.target.value },
            )
          }
        />
        <Button
          type="button"
          variant="link"
          className="justify-self-start px-0"
          onClick={() =>
            setFactor(
              factor.kind === 'code'
                ? { kind: 'recovery', recoveryCode: '' }
                : { kind: 'code', code: '' },
            )
          }
        >
          {factor.kind === 'code'
            ? 'Use a recovery code instead'
            : 'Use a code from the app instead'}
        </Button>
      </div>
    </>
  )
}

/**
 * Enrolling an authenticator, replacing the recovery codes, and turning
 * two-factor off — each behind the password the service will check, and,
 * once an authenticator exists, a code or a recovery code alongside it.
 * `onChanged` runs after `confirmTotp`, `disableTotp` and `newRecoveryCodes`,
 * so the section that shows "on" or "off" and the remaining-codes count shows
 * what the service says, not a local guess.
 *
 * Every one-time secret this component holds — the enrolment secret and uri,
 * kept together in `setupStep` — is cleared by `closeFlow`, and `closeFlow`
 * is the one function both a dialog's own `close` event (Escape included) and
 * every button that leaves the flow call: there is one place that clears it,
 * not one per way of leaving. The recovery codes follow the same shape in
 * their own smaller pair, `codes` and `closeCodes`.
 */
export function TwoFactor({
  enabled,
  recoveryCodesLeft,
  onChanged,
}: { enabled: boolean; recoveryCodesLeft: number; onChanged: () => void }) {
  const client = useClient()
  const [flow, setFlow] = useState<'idle' | 'setup' | 'disable' | 'recovery'>('idle')
  const [setupStep, setSetupStep] = useState<SetupStep>(emptySetup)
  const [disablePassword, setDisablePassword] = useState('')
  const [disableFactor, setDisableFactor] = useState<Factor>(emptyFactor)
  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [recoveryFactor, setRecoveryFactor] = useState<Factor>(emptyFactor)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [clientProblem, setClientProblem] = useState<string | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  // A failure that is not an `ApiError` is a defect, not a refusal to show,
  // and is rethrown to React the way `Confirm` does.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  // The one place every secret `setupStep` can hold — the password, the
  // enrolment secret, the uri — is discarded. Referenced by the setup,
  // disable and recovery `Modal`s' own `onClose` (which fires for Escape and
  // a `method="dialog"` form exactly as it does for a click) and by every
  // successful submit, so there is no separate "and also clear it here" path
  // to forget.
  const closeFlow = () => {
    setFlow('idle')
    setSetupStep(emptySetup)
    setDisablePassword('')
    setDisableFactor(emptyFactor)
    setRecoveryPassword('')
    setRecoveryFactor(emptyFactor)
    setError(null)
    setClientProblem(null)
  }

  // The one place the recovery codes are discarded — by the codes `Modal`'s
  // own `onClose` and by "I have saved them" alike.
  const closeCodes = () => setCodes(null)

  const open = (f: 'setup' | 'disable' | 'recovery') => {
    setError(null)
    setClientProblem(null)
    setFlow(f)
  }

  const continueSetup = async (e: FormEvent) => {
    e.preventDefault()
    if (setupStep.name !== 'password') return
    setBusy(true)
    setError(null)
    try {
      const r = await client.startTotp({ password: setupStep.password })
      setSetupStep({
        name: 'confirm',
        password: setupStep.password,
        secret: r.secret,
        uri: r.uri,
        code: '',
      })
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }

  const confirmSetup = async (e: FormEvent) => {
    e.preventDefault()
    if (setupStep.name !== 'confirm') return
    setError(null)
    if (setupStep.code === '') {
      setClientProblem('Enter the code from the app.')
      return
    }
    setClientProblem(null)
    setBusy(true)
    try {
      const r = await client.confirmTotp({ password: setupStep.password, code: setupStep.code })
      closeFlow()
      setCodes(r.recoveryCodes)
      onChanged()
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }

  const submitDisable = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const problem = factorProblem(disableFactor)
    if (problem) {
      setClientProblem(problem)
      return
    }
    setClientProblem(null)
    setBusy(true)
    try {
      await client.disableTotp({ password: disablePassword, ...factorBody(disableFactor) })
      closeFlow()
      onChanged()
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }

  const submitRecovery = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const problem = factorProblem(recoveryFactor)
    if (problem) {
      setClientProblem(problem)
      return
    }
    setClientProblem(null)
    setBusy(true)
    try {
      const r = await client.newRecoveryCodes({
        password: recoveryPassword,
        ...factorBody(recoveryFactor),
      })
      closeFlow()
      setCodes(r.recoveryCodes)
      // The remaining-codes count is service state too: without this, "On. 3
      // recovery codes left." keeps showing the old count after ten new ones
      // were just issued.
      onChanged()
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="two-factor-heading" className="grid gap-4">
      <h2 id="two-factor-heading" className="font-serif text-lg font-semibold text-foreground">
        Two-factor authentication
      </h2>
      {!enabled && (
        <Button type="button" className="justify-self-start" onClick={() => open('setup')}>
          Set up an authenticator app
        </Button>
      )}
      {enabled && (
        <>
          <p className="text-sm text-muted-foreground">
            On. {recoveryCodesLeft} recovery codes left.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => open('recovery')}>
              New recovery codes
            </Button>
            <Button type="button" variant="destructive" onClick={() => open('disable')}>
              Turn off two-factor
            </Button>
          </div>
        </>
      )}

      <Modal open={flow === 'setup'} onClose={closeFlow} title="Set up an authenticator app">
        {setupStep.name === 'password' && (
          <form className="grid gap-4" onSubmit={continueSetup}>
            <div className="grid gap-1">
              <Label htmlFor="setup-password">Your password</Label>
              <Input
                id="setup-password"
                type="password"
                autoComplete="current-password"
                value={setupStep.password}
                onChange={(e) => setSetupStep({ name: 'password', password: e.target.value })}
              />
            </div>
            {error && <ErrorNote error={error} />}
            <Button type="submit" disabled={busy} className="justify-self-start">
              Continue
            </Button>
          </form>
        )}
        {setupStep.name === 'confirm' && (
          <form className="grid gap-4" onSubmit={confirmSetup}>
            <TotpQr uri={setupStep.uri} />
            <p className="font-mono text-sm">{setupStep.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
            <div className="grid gap-1">
              <Label htmlFor="setup-code">Code from the app</Label>
              <Input
                id="setup-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={setupStep.code}
                onChange={(e) => setSetupStep({ ...setupStep, code: e.target.value })}
              />
            </div>
            {clientProblem && (
              <p role="alert" className="text-sm text-destructive">
                {clientProblem}
              </p>
            )}
            {error && <ErrorNote error={error} />}
            <Button type="submit" disabled={busy} className="justify-self-start">
              Turn on two-factor
            </Button>
          </form>
        )}
      </Modal>

      <Modal open={flow === 'disable'} onClose={closeFlow} title="Turn off two-factor?">
        <form className="grid gap-4" onSubmit={submitDisable}>
          <SecondFactorFields
            idPrefix="disable"
            password={disablePassword}
            setPassword={setDisablePassword}
            factor={disableFactor}
            setFactor={setDisableFactor}
          />
          {clientProblem && (
            <p role="alert" className="text-sm text-destructive">
              {clientProblem}
            </p>
          )}
          {error && <ErrorNote error={error} />}
          <Button
            type="submit"
            variant="destructive"
            disabled={busy}
            className="justify-self-start"
          >
            Turn it off
          </Button>
        </form>
      </Modal>

      <Modal open={flow === 'recovery'} onClose={closeFlow} title="New recovery codes?">
        <form className="grid gap-4" onSubmit={submitRecovery}>
          <SecondFactorFields
            idPrefix="recovery"
            password={recoveryPassword}
            setPassword={setRecoveryPassword}
            factor={recoveryFactor}
            setFactor={setRecoveryFactor}
          />
          {clientProblem && (
            <p role="alert" className="text-sm text-destructive">
              {clientProblem}
            </p>
          )}
          {error && <ErrorNote error={error} />}
          <Button type="submit" disabled={busy} className="justify-self-start">
            Replace the codes
          </Button>
        </form>
      </Modal>

      <Modal open={codes !== null} onClose={closeCodes} title="Your recovery codes">
        {codes && (
          <div className="grid gap-4">
            <ol className="grid grid-cols-2 gap-1 font-mono text-sm">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <CopyButton value={codes.join('\n')} label="Copy all ten codes" />
            <p className="text-sm text-muted-foreground">
              This is the only time these codes are shown.
            </p>
            <Button type="button" className="justify-self-start" onClick={closeCodes}>
              I have saved them
            </Button>
          </div>
        )}
      </Modal>
    </section>
  )
}
