import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Domain, DomainCheck, DomainStatus } from '@/api/types'
import { Confirm } from '@/app/Confirm'
import { CopyButton } from '@/app/CopyButton'
import { ErrorNote } from '@/app/ErrorNote'
import { browserZone } from '@/app/clock'
import { formatInstant } from '@/app/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type FormEvent, useState } from 'react'

/** A check's result in words. An error is not an absent record, and is not said as one. */
export const CHECK_WORDS: Record<DomainStatus, string> = {
  verified: 'Found the record',
  missing_token: 'Record not found',
  error: 'The DNS lookup failed',
}

export function DomainCard({ d, onChanged }: { d: Domain; onChanged: () => void }) {
  const client = useClient()
  const zone = browserZone()
  const [check, setCheck] = useState<DomainCheck | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [rootUrl, setRootUrl] = useState(d.rootUrl ?? '')
  const [notFoundUrl, setNotFoundUrl] = useState(d.notFoundUrl ?? '')

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else throw err
    }
  }

  const saveUrls = (e: FormEvent) => {
    e.preventDefault()
    const body: { rootUrl?: string | null; notFoundUrl?: string | null } = {}
    if (rootUrl !== (d.rootUrl ?? '')) body.rootUrl = rootUrl === '' ? null : rootUrl
    if (notFoundUrl !== (d.notFoundUrl ?? ''))
      body.notFoundUrl = notFoundUrl === '' ? null : notFoundUrl
    if (Object.keys(body).length === 0) return
    void run(async () => {
      await client.updateDomain(d.id, body)
      onChanged()
    })
  }

  const last = check ? { ...check, checkedAt: null } : d.lastCheck
  return (
    <Card>
      <section aria-labelledby={`domain-${d.id}`}>
        <CardContent className="grid gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`domain-${d.id}`} className="font-mono text-base font-semibold">
              {d.host}
            </h2>
            {d.verified ? (
              <Badge>Verified</Badge>
            ) : (
              <Badge variant="destructive">Not verified: its links answer 404</Badge>
            )}
          </div>
          {/* The record, prominent while it is still needed, and always available. */}
          <div className="grid gap-1 text-sm">
            <p className="text-muted-foreground">
              {d.verified ? 'The record that proved it:' : 'Publish this TXT record, then check:'}
            </p>
            <dl className="grid grid-cols-[max-content_1fr_auto] items-center gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="break-all font-mono">{d.verificationRecord.name}</dd>
              <dd>
                <CopyButton value={d.verificationRecord.name} label="Copy the record name" />
              </dd>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="font-mono">TXT</dd>
              <dd />
              <dt className="text-muted-foreground">Value</dt>
              <dd className="break-all font-mono">{d.verificationRecord.value}</dd>
              <dd>
                <CopyButton value={d.verificationRecord.value} label="Copy the record value" />
              </dd>
            </dl>
          </div>
          <div className="text-sm">
            {last === null ? (
              <p className="text-muted-foreground">Not checked yet</p>
            ) : check ? (
              <p>{`${CHECK_WORDS[check.status]}: ${check.detail ?? ''}`}</p>
            ) : (
              <p>
                <span className="font-medium">{CHECK_WORDS[last.status]}</span>
                {last.detail && <span className="block text-muted-foreground">{last.detail}</span>}
                {d.lastCheck && (
                  <span className="block text-xs text-muted-foreground">
                    {formatInstant(d.lastCheck.checkedAt, zone)}
                  </span>
                )}
              </p>
            )}
          </div>
          <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={saveUrls}>
            <div className="grid gap-1">
              <Label htmlFor={`root-${d.id}`}>Root URL</Label>
              <Input
                id={`root-${d.id}`}
                value={rootUrl}
                onChange={(e) => setRootUrl(e.target.value)}
                placeholder="Where https://host/ goes"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`nf-${d.id}`}>Not-found URL</Label>
              <Input
                id={`nf-${d.id}`}
                value={notFoundUrl}
                onChange={(e) => setNotFoundUrl(e.target.value)}
                placeholder="Where an unknown slug goes"
              />
            </div>
            <Button type="submit" variant="secondary">
              Save URLs
            </Button>
          </form>
          {error && <ErrorNote error={error} />}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => run(async () => setCheck(await client.checkDomain(d.id)))}
            >
              Check now
            </Button>
            {d.verified && (
              <Confirm
                title={`Stop serving ${d.host}?`}
                body="Links on this domain will answer 404, and its certificate will not be renewed. A certificate already issued is presented until it expires, so this is not a way to take the domain off the air quickly."
                action={`Stop serving ${d.host}`}
                destructive
                onConfirm={async () => {
                  const r = await client.unverifyDomain(d.id)
                  setNote(r.note)
                  onChanged()
                }}
                trigger={<Button variant="outline">Stop serving</Button>}
              />
            )}
            <Confirm
              title={`Delete ${d.host}?`}
              body="Every link on it goes with it — their targets and their click counters. Clicks already recorded stay in the reports."
              action={`Delete ${d.host}`}
              destructive
              onConfirm={async () => {
                await client.deleteDomain(d.id)
                onChanged()
              }}
              trigger={<Button variant="destructive">Delete</Button>}
            />
          </div>
        </CardContent>
      </section>
    </Card>
  )
}
