import type { BreakdownRow } from '@/api/types'
import { CLASS_LABELS, OUTCOME_LABELS, type REPORT_DIMENSIONS } from '@/api/vocabulary'
import { countryName } from '@/app/format'

export type Dimension = (typeof REPORT_DIMENSIONS)[number]

/** The link id every click that reached no link carries. */
export const ZERO_LINK = '00000000-0000-0000-0000-000000000000'

const DEVICE: Record<string, string> = { ios: 'iOS', android: 'Android', desktop: 'Desktop' }
const ACTION: Record<string, string> = {
  nothing: 'Counted',
  flag: 'Flagged',
  block: 'Blocked',
  safe: 'Sent to the safe URL',
  '': 'None (human or unknown)',
}

const unknown = (v: string) => (v === '' ? 'Unknown' : v)

/**
 * What a breakdown row is called. One entry per dimension, and a `Record` over
 * them, so a dimension added to the vocabulary without a label here is a type
 * error rather than a row showing a raw value.
 */
const LABEL: Record<
  Dimension,
  (row: BreakdownRow, ctx: { targets?: Map<string, string> }) => string
> = {
  country: (r) => countryName(r.value),
  device: (r) => DEVICE[r.value] ?? unknown(r.value),
  os: (r) => unknown(r.value),
  browser: (r) => unknown(r.value),
  referrer: (r) => (r.value === '' ? 'No referrer' : r.value),
  target: (r, ctx) => {
    if (r.value === '') return 'No target (turned away)'
    return ctx.targets?.get(r.value) ?? 'A target since removed'
  },
  class: (r) => CLASS_LABELS[r.value as keyof typeof CLASS_LABELS] ?? unknown(r.value),
  action: (r) => ACTION[r.value] ?? r.value,
  outcome: (r) => OUTCOME_LABELS[r.value as keyof typeof OUTCOME_LABELS] ?? r.value,
  link: (r) => {
    if (r.value === ZERO_LINK) return 'No link (unknown slugs and domain roots)'
    if (!r.link) return 'A deleted link'
    const where = `${r.link.host}/${r.link.slug}`
    return r.link.name ? `${where} — ${r.link.name}` : where
  },
}

export function rowLabel(
  dimension: Dimension,
  row: BreakdownRow,
  ctx: { targets?: Map<string, string> },
): string {
  return LABEL[dimension](row, ctx)
}
