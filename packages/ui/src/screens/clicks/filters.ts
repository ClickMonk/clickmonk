import { OUTCOMES, TRAFFIC_CLASSES } from '@/api/vocabulary'

export interface ClickFilterChoice {
  link?: string
  class?: string
  outcome?: string
  country?: string
}

const KEYS = ['link', 'class', 'outcome', 'country'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const valid: Record<(typeof KEYS)[number], (v: string) => boolean> = {
  link: (v) => UUID.test(v),
  class: (v) => (TRAFFIC_CLASSES as readonly string[]).includes(v),
  outcome: (v) => (OUTCOMES as readonly string[]).includes(v),
  country: (v) => /^[A-Z]{2}$/.test(v),
}

/**
 * The log's filters from the address. A value the service would refuse is left
 * out, and the screen says a filter was dropped, rather than sending a request
 * that answers 400 for a reason the operator did not type.
 */
export function readFilters(params: URLSearchParams): {
  filters: ClickFilterChoice
  problem: string | null
} {
  const filters: ClickFilterChoice = {}
  let dropped = false
  for (const k of KEYS) {
    const v = params.get(k)
    if (v === null) continue
    if (valid[k](v)) filters[k] = v
    else dropped = true
  }
  return {
    filters,
    problem: dropped ? 'A filter in this address could not be used and was left out.' : null,
  }
}

export function writeFilters(params: URLSearchParams, filters: ClickFilterChoice): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const k of KEYS) {
    const v = filters[k]
    if (v) next.set(k, v)
    else next.delete(k)
  }
  return next
}
