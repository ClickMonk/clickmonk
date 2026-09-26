import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { NewApiKey } from '@/api/types'
import { Confirm } from '@/app/Confirm'
import { CopyButton } from '@/app/CopyButton'
import { ErrorNote } from '@/app/ErrorNote'
import { browserZone } from '@/app/clock'
import { formatInstant } from '@/app/format'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/ui/modal'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type FormEvent, useState } from 'react'

const DAYS_RE = /^\d+$/

// Both bounds below are `admin`'s own (`packages/admin/src/keys.ts`,
// `MAX_KEY_NAME_LENGTH` and `MAX_KEY_DAYS`), restated rather than imported —
// the interface imports nothing from a service package at runtime. A drift
// here is not caught by a test the way `core`'s bounds are in
// `vocabulary.test.ts`; keep this comment in step with that file by hand.
function nameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 100) return 'A name is 1 to 100 characters.'
  return undefined
}

function expiresProblem(days: string): string | undefined {
  if (days === '') return undefined
  if (!DAYS_RE.test(days) || Number(days) < 1 || Number(days) > 3650)
    return 'A whole number of days from 1 to 3,650.'
  return undefined
}

/**
 * API keys: what one can and cannot do, creating one (shown once), and the
 * list — revoking one, or noting when only the newest 200 are shown. The list
 * reloads after every create and every revoke; nothing is patched locally.
 */
export function ApiKeys() {
  const client = useClient()
  const zone = browserZone()
  const list = useLoad(() => client.keys(), [])
  const keys = list.data?.keys ?? []

  const [name, setName] = useState('')
  const [expiresDays, setExpiresDays] = useState('')
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<ApiError | null>(null)
  const [newKey, setNewKey] = useState<NewApiKey | null>(null)
  // A failure that is not an `ApiError` is a defect, not a refusal to show,
  // and is rethrown to React the way `Confirm` does.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  // The one place the new key is discarded — by the dialog's own `onClose`
  // (Escape included) and by "I have saved it" alike, so there is one place
  // that clears it, not one per way of leaving.
  const closeNewKey = () => setNewKey(null)

  const create = (e: FormEvent) => {
    e.preventDefault()
    const probs: Record<string, string> = {}
    const n = nameProblem(name)
    if (n) probs.name = n
    const d = expiresProblem(expiresDays)
    if (d) probs.expiresDays = d
    setProblems(probs)
    if (Object.keys(probs).length > 0) return
    setCreating(true)
    setCreateError(null)
    void (async () => {
      try {
        const body: { name: string; expiresDays?: number } = { name }
        if (expiresDays !== '') body.expiresDays = Number(expiresDays)
        const k = await client.createKey(body)
        setNewKey(k)
        setName('')
        setExpiresDays('')
        list.reload()
      } catch (err) {
        if (err instanceof ApiError) setCreateError(err)
        else setThrown(err)
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <section aria-labelledby="api-keys-heading" className="grid gap-4">
      <h2 id="api-keys-heading" className="font-serif text-lg font-semibold text-foreground">
        API keys
      </h2>
      <p className="text-sm text-muted-foreground">
        A key can read and change domains, links and settings, and read reports. It cannot sign in,
        see sessions, change the password or two-factor settings, or create other keys.
      </p>
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={create}>
        <div className="grid gap-1">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            aria-invalid={problems.name ? true : undefined}
            aria-describedby={problems.name ? 'key-name-error' : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {problems.name && (
            <p id="key-name-error" className="text-sm text-destructive">
              {problems.name}
            </p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="key-expires">Expires after (days)</Label>
          <Input
            id="key-expires"
            type="text"
            inputMode="numeric"
            value={expiresDays}
            aria-invalid={problems.expiresDays ? true : undefined}
            aria-describedby={problems.expiresDays ? 'key-expires-error' : undefined}
            onChange={(e) => setExpiresDays(e.target.value)}
          />
          {problems.expiresDays && (
            <p id="key-expires-error" className="text-sm text-destructive">
              {problems.expiresDays}
            </p>
          )}
        </div>
        <Button type="submit" disabled={creating}>
          Create key
        </Button>
      </form>
      {createError && <ErrorNote error={createError} />}

      {list.error && <ErrorNote error={list.error} />}
      {list.state === 'ok' && keys.length === 0 && (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      )}
      {list.state !== 'error' && keys.length > 0 && (
        <div aria-busy={list.state === 'loading'}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell>{formatInstant(k.createdAt, zone)}</TableCell>
                  <TableCell>
                    {k.lastUsedAt ? formatInstant(k.lastUsedAt, zone) : 'Never'}
                  </TableCell>
                  <TableCell>{k.expiresAt ? formatInstant(k.expiresAt, zone) : 'Never'}</TableCell>
                  <TableCell>
                    {k.revokedAt ? (
                      <span className="text-xs text-muted-foreground">
                        Revoked {formatInstant(k.revokedAt, zone)}
                      </span>
                    ) : (
                      <Confirm
                        title={`Revoke ${k.name}?`}
                        body="Scripts using it stop working at once."
                        action="Revoke key"
                        destructive
                        onConfirm={async () => {
                          await client.revokeKey(k.id)
                          list.reload()
                        }}
                        trigger={
                          <Button type="button" variant="outline" size="sm">
                            Revoke
                          </Button>
                        }
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.state !== 'error' && list.data?.truncated && (
        <p className="text-sm text-muted-foreground">
          The newest 200 keys are shown; <code>clickmonk apikey list</code> shows every one.
        </p>
      )}

      <Modal open={newKey !== null} onClose={closeNewKey} title="API key created">
        {newKey && (
          <div className="grid gap-4">
            <p className="break-all font-mono text-sm">{newKey.key}</p>
            <CopyButton value={newKey.key} label="Copy the key" />
            <p className="text-sm text-muted-foreground">
              This is the only time this key is shown.
            </p>
            <Button type="button" className="justify-self-start" onClick={closeNewKey}>
              I have saved it
            </Button>
          </div>
        )}
      </Modal>
    </section>
  )
}
