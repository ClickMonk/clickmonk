import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { useRefresh } from '@/app/refresh'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type FormEvent, useState } from 'react'
import { DomainCard } from './DomainCard'

/**
 * Every link domain: the add form, the words on how a domain becomes
 * verified — the screen offers no button for that, only a check — and one
 * card per domain.
 */
export function Domains() {
  const client = useClient()
  const { round } = useRefresh()
  const list = useLoad(() => client.domains(), [round])
  const [host, setHost] = useState('')
  const [addError, setAddError] = useState<ApiError | null>(null)
  const [adding, setAdding] = useState(false)
  // See `DomainCard`: a non-`ApiError` failure is a defect, rethrown to React
  // rather than left as an unhandled rejection from `add`'s own async IIFE.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  const add = (e: FormEvent) => {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    void (async () => {
      try {
        await client.addDomain({ host })
        setHost('')
        list.reload()
      } catch (err) {
        if (err instanceof ApiError) setAddError(err)
        else setThrown(err)
      } finally {
        setAdding(false)
      }
    })()
  }

  const domains = list.data?.domains ?? []

  return (
    <div className="grid gap-6">
      <PageHeader title="Domains" description="A link domain serves links once it is verified." />
      <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
        <div className="grid gap-1">
          <Label htmlFor="domain-host">Host name</Label>
          <Input
            id="domain-host"
            value={host}
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? 'domain-host-error' : undefined}
            onChange={(e) => setHost(e.target.value)}
          />
          {addError && (
            <p id="domain-host-error" className="text-sm text-destructive">
              {addError.message}
            </p>
          )}
        </div>
        <Button type="submit" disabled={adding}>
          Add domain
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        A domain is verified only by finding its TXT record, or by clickmonk domain add --verified
        on the server.
      </p>
      {list.error && <ErrorNote error={list.error} />}
      {list.state === 'ok' && domains.length === 0 && (
        <p className="text-sm text-muted-foreground">No domains yet.</p>
      )}
      {list.state !== 'error' && domains.length > 0 && (
        <div
          aria-busy={list.state === 'loading'}
          className={list.state === 'loading' ? 'grid gap-4 opacity-50' : 'grid gap-4'}
        >
          {domains.map((d) => (
            <DomainCard key={d.id} d={d} onChanged={list.reload} />
          ))}
        </div>
      )}
      {list.state !== 'error' && list.data?.truncated && (
        <p className="text-sm text-muted-foreground">
          Only the first 500 domains by name are shown; clickmonk domain list shows every one.
        </p>
      )}
    </div>
  )
}
