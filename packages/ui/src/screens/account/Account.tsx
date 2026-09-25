import type { Me } from '@/api/types'
import { PageHeader } from '@/app/PageHeader'
import { ApiKeys } from './ApiKeys'
import { Password } from './Password'
import { Sessions } from './Sessions'
import { TwoFactor } from './TwoFactor'

/**
 * The one admin's own credentials: the password, two-factor authentication,
 * the sessions signed in, and the API keys. `onAccountChanged` is called
 * after a two-factor change so the caller can refresh `me` — the state this
 * screen shows for "on" or "off" is the service's, not a local guess.
 */
export function Account({ me, onAccountChanged }: { me: Me; onAccountChanged: () => void }) {
  return (
    <div className="grid gap-8">
      <PageHeader title="Account" description={me.email} />
      <Password />
      <TwoFactor
        enabled={me.totpEnabled}
        recoveryCodesLeft={me.recoveryCodesLeft}
        onChanged={onAccountChanged}
      />
      <Sessions />
      <ApiKeys />
    </div>
  )
}
