import { useClient } from '@/api/context'
import type { Link } from '@/api/types'
import { Confirm } from '@/app/Confirm'
import { CopyButton } from '@/app/CopyButton'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { browserZone, useNowMs } from '@/app/clock'
import { useRefresh } from '@/app/refresh'
import { useLoad } from '@/app/useLoad'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { WindowPicker } from '@/window/WindowPicker'
import { choiceParams } from '@/window/range'
import { useWindow } from '@/window/useWindow'
import { Link as RouterLink, useNavigate, useParams } from 'react-router'
import { type Panel, Report } from '../overview/Report'
import { linkFacts } from './linkFacts'

export const LINK_PANELS = (targets: Map<string, string>): Panel[] => [
  { dimension: 'target', title: 'Targets', targets },
  { dimension: 'country' },
  { dimension: 'referrer' },
  { dimension: 'device' },
  { dimension: 'class' },
  { dimension: 'outcome' },
]

export function LinkReport() {
  const { id = '' } = useParams()
  const client = useClient()
  const navigate = useNavigate()
  const { round } = useRefresh()
  const now = useNowMs()
  const zone = browserZone()
  const w = useWindow()
  const r = useLoad((signal) => client.link(id, { signal }), [id, round])

  if (r.error?.status === 404) {
    return <PageHeader title="No such link" description="It may have been deleted." />
  }
  if (r.error) return <ErrorNote error={r.error} />
  const link: Link | undefined = r.data
  if (!link) return null

  const facts = linkFacts(link, now, zone)
  const targets = new Map(link.targets.map((t) => [t.id, t.url]))
  const clicks = new URLSearchParams({ link: link.id, ...choiceParams(w.choice) })

  return (
    <div className="grid gap-6">
      <PageHeader
        title={link.name ?? `${link.host}/${link.slug}`}
        description={
          <span className="inline-flex items-center gap-2">
            <span className="font-mono">{link.url}</span>
            <CopyButton value={link.url} label="Copy the link" />
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <RouterLink to={`/clicks?${clicks}`}>Clicks</RouterLink>
            </Button>
            <Button asChild variant="outline">
              <RouterLink to={`/links/${encodeURIComponent(link.id)}/edit`}>Edit</RouterLink>
            </Button>
            <Confirm
              title={`Delete ${link.host}/${link.slug}?`}
              body="Its targets and its click counter go with it. Clicks already recorded stay in the reports."
              action="Delete link"
              destructive
              onConfirm={async () => {
                await client.deleteLink(link.id)
                navigate('/links')
              }}
              trigger={<Button variant="destructive">Delete</Button>}
            />
          </>
        }
      />
      <Card>
        <CardContent className="grid gap-3 p-4">
          <div className="flex flex-wrap gap-1">
            {[...facts.status, ...facts.rules].map((f) => (
              <Badge key={f} variant="secondary">
                {f}
              </Badge>
            ))}
          </div>
          <ul className="grid gap-1 text-sm">
            {link.targets.map((t) => (
              <li key={t.id} className="flex gap-3">
                <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{`${t.weight}%`}</span>
                <span className="min-w-0 break-all">{t.url}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <WindowPicker />
      <Report link={link.id} panels={LINK_PANELS(targets)} />
    </div>
  )
}
