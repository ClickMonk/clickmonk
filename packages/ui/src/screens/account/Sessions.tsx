import { useClient } from '@/api/context'
import { Confirm } from '@/app/Confirm'
import { ErrorNote } from '@/app/ErrorNote'
import { browserZone } from '@/app/clock'
import { formatInstant } from '@/app/format'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * Every session signed in, with the whole address it opened from — the one
 * place in the product that shows that, because these are the operator's own
 * devices. Revoking reloads the list, this browser's own included: for that
 * one, the reload is what reaches the service and comes back 401, which is
 * the only way this browser learns it has been signed out.
 */
export function Sessions({ reloadKey = 0 }: { reloadKey?: number } = {}) {
  const client = useClient()
  const zone = browserZone()
  // `reloadKey` lets `Account` ask for a reload from outside — after a
  // password change, which signs out every other session — without this
  // component patching its own list from a response it never asked for.
  const list = useLoad(() => client.sessions(), [reloadKey])
  const sessions = list.data ?? []

  return (
    <section aria-labelledby="sessions-heading" className="grid gap-4">
      <h2 id="sessions-heading" className="font-serif text-lg font-semibold text-foreground">
        Sessions
      </h2>
      {list.error && <ErrorNote error={list.error} />}
      {list.state === 'ok' && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions.</p>
      )}
      {list.state !== 'error' && sessions.length > 0 && (
        <div aria-busy={list.state === 'loading'}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Browser</TableHead>
                <TableHead>Signed in from</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell title={s.userAgent} className="max-w-56 truncate">
                    {s.userAgent}
                  </TableCell>
                  <TableCell className="font-mono">{s.ip}</TableCell>
                  <TableCell>{formatInstant(s.lastSeenAt, zone)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {s.current && (
                        <span className="text-xs text-muted-foreground">This browser</span>
                      )}
                      <Confirm
                        title={s.current ? 'Sign this browser out?' : 'Sign that session out?'}
                        body={
                          s.current
                            ? 'This browser is signed out.'
                            : 'Whoever is using it has to sign in again.'
                        }
                        action={s.current ? 'Sign this browser out' : 'Sign that session out'}
                        destructive
                        onConfirm={async () => {
                          await client.revokeSession(s.id)
                          list.reload()
                        }}
                        trigger={
                          <Button type="button" variant="outline" size="sm">
                            Sign out
                          </Button>
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
