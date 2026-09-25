import type { Click } from '@/api/types'
import { CLASS_LABELS, OUTCOME_LABELS } from '@/api/vocabulary'
import { countryName, formatInstant } from '@/app/format'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'
import { Fragment, useState } from 'react'

/** Every field of a click, labelled, in the order the service returns them. */
const FIELDS: [keyof Click, string][] = [
  ['clickId', 'Click ID'],
  ['at', 'Time (UTC)'],
  ['host', 'Host'],
  ['path', 'Path'],
  ['outcome', 'Outcome'],
  ['step', 'Decided at'],
  ['status', 'Status'],
  ['destination', 'Sent to'],
  ['targetId', 'Target (rotation)'],
  ['linkId', 'Link ID'],
  ['domainId', 'Domain ID'],
  ['visitorId', 'Visitor'],
  ['returning', 'Returning'],
  ['country', 'Country'],
  ['region', 'Region'],
  ['city', 'City'],
  ['geoSource', 'Location source'],
  ['device', 'Device'],
  ['os', 'Operating system'],
  ['browser', 'Browser'],
  ['asn', 'Network (ASN)'],
  ['class', 'Class'],
  ['signals', 'Signals'],
  ['action', 'Action'],
  ['referrer', 'Referrer'],
  ['userAgent', 'User agent'],
  ['network', 'Address (network)'],
  ['capUnchecked', 'Cap not checked'],
]

const text = (v: unknown): string =>
  v === null || v === '' ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v)

export function ClickRow({ c, zone }: { c: Click; zone: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Fragment>
      <TableRow>
        <TableCell className="whitespace-nowrap text-sm">{formatInstant(c.at, zone)}</TableCell>
        <TableCell className="max-w-56 truncate text-sm">{`${c.host}${c.path}`}</TableCell>
        <TableCell className="text-sm">
          {OUTCOME_LABELS[c.outcome as keyof typeof OUTCOME_LABELS] ?? c.outcome}
        </TableCell>
        <TableCell className="text-sm">
          {c.class ? (CLASS_LABELS[c.class as keyof typeof CLASS_LABELS] ?? c.class) : '—'}
        </TableCell>
        <TableCell className="text-sm">{c.country ? countryName(c.country) : 'Unknown'}</TableCell>
        <TableCell className="font-mono text-xs">
          {c.network ?? <span title="Blanked or not recorded">—</span>}
        </TableCell>
        <TableCell>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={open ? 'Hide the fields of this click' : 'Show every field of this click'}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Less' : 'More'}
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={7}>
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
              {FIELDS.map(([k, label]) => (
                <Fragment key={k}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all font-mono">{text(c[k])}</dd>
                </Fragment>
              ))}
            </dl>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}
