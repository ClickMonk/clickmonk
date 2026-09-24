/**
 * The raw click log.
 *
 * Everything else in these reports reads an hourly rollup; this reads the
 * clicks themselves, which is why it is the only place that has to think about
 * two things the rollups solved once.
 *
 * **FINAL.** A segment the worker shipped twice is two identical rows here
 * until a merge collapses them, so a plain SELECT would show one click as two.
 * FINAL is the engine's own dedup, keyed exactly as the table is keyed. A
 * hand-rolled `LIMIT 1 BY click_id` would be the same rule stated a second
 * time, in a second place, where it could come to disagree with the one the
 * rollups use.
 *
 * **The address is a network and the field says so.** A field called `ip`
 * holding `198.51.100.0/24` invites its next reader to treat it as an address;
 * `network` cannot be misread, and it means no response this service sends has
 * a field called `ip` at all — which a test can check across the whole surface
 * rather than one route at a time. The truncation itself is `truncateIp`, the
 * same function the export calls, and it is never done in SQL: two copies of a
 * rule about what an operator may see is one too many.
 */
import { OUTCOMES, TRAFFIC_CLASSES } from '@clickmonk/core'
import { addressOnly, truncateIp } from '@clickmonk/ipdata'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { fail } from './http.js'
import {
  type ReportWindow,
  WINDOW_FIELDS,
  chRows,
  parseWindow,
  readQuery,
  requireCh,
  withSlot,
} from './reports.js'

/** Clicks in one page, and the ceiling a caller may ask for. */
export const DEFAULT_CLICK_PAGE = 50
export const MAX_CLICK_PAGE = 200

/**
 * The filters the product promises: link, class, outcome, country and time.
 * Shared with the export, which filters the same rows it would have listed.
 */
export const CLICK_FILTER_FIELDS = {
  ...WINDOW_FIELDS,
  class: z.enum(TRAFFIC_CLASSES).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, 'must be a two-letter upper-case country code')
    .optional(),
}

const ListQuery = z
  .object({
    ...CLICK_FILTER_FIELDS,
    // `.int()`, and a refusal test for a fractional one: this number is
    // interpolated into `LIMIT`, so without it `limit=2.5` reaches the store as
    // `LIMIT 3.5`, ClickHouse answers an error, and the caller's own bad field
    // is reported back to them as an install outage.
    limit: z.coerce.number().int().min(1).max(MAX_CLICK_PAGE).default(DEFAULT_CLICK_PAGE),
    cursor: z.string().max(80).optional(),
  })
  .strict()

/**
 * A page boundary: the instant and the id of the last row of the page before.
 * Opaque to the caller, and parsed strictly — it reaches a comparison against
 * a `DateTime64` and a `UUID`, so anything that is not exactly those two things
 * is refused here rather than by ClickHouse.
 */
const CURSOR_RE = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseCursor(value: string): { atMs: number; clickId: string } {
  const m = CURSOR_RE.exec(value)
  // `return fail(…)`: a bare call does not narrow `m`, because `fail` is a
  // const arrow rather than a declaration. With the return, the lines below see
  // a match; the casts are for the index signature, which does not know the
  // pattern has two groups.
  if (!m) return fail(400, 'invalid_query', 'cursor: not a cursor from a previous page')
  return { atMs: Number(m[1] as string), clickId: m[2] as string }
}

/**
 * One row as `JSONEachRow` really hands it over. The distinction matters and is
 * easy to get wrong: ClickHouse quotes only 64-bit integers, so `at_ms` from
 * `toUnixTimestamp64Milli` arrives as a **string** while `status`, `returning`,
 * `asn` and `cap_unchecked` arrive as **numbers**, and `signals` as an array.
 */
export interface ClickRow {
  click_id: string
  at_ms: string
  host: string
  path: string
  domain_id: string
  link_id: string
  outcome: string
  step: string
  status: number
  destination: string
  target_id: string
  visitor_id: string
  returning: number
  country: string
  region: string
  city: string
  geo_source: string
  device: string
  user_agent: string
  referrer: string
  ip: string
  cap_unchecked: number
  traffic_class: string
  signals: string[]
  action: string
  os: string
  browser: string
  asn: number
}

/**
 * The columns both readers select, in the order the CSV writes them.
 *
 * `toUnixTimestamp64Milli` rather than the column itself: an instant that
 * travels as a number needs no agreement about how either end formats a
 * timestamp, and it is also exactly what a cursor carries.
 */
export const CLICK_COLUMNS = `click_id, toUnixTimestamp64Milli(time) AS at_ms, host, path,
  domain_id, link_id, outcome, step, status, destination, target_id, visitor_id, returning,
  country, region, city, geo_source, device, os, browser, asn, traffic_class, signals, action,
  referrer, user_agent, ip, cap_unchecked`

const none = (s: string): string | null => (s === '' ? null : s)

/**
 * The network a click came from, or nothing.
 *
 * `addressOnly` first, always. `truncateIp` answers null for anything that is
 * not bare address text — a port or a bracketed literal included — and the
 * stored column is a plain `String` that the record schema bounds only in
 * length, so a click recorded through a proxy that spelled the address
 * `[2001:db8::5]:443` would otherwise read as "no network" rather than as the
 * /64 it came from. Returning null is the right answer for a value the parser
 * genuinely does not recognise and the wrong one for a value it would
 * recognise a character later.
 */
const networkOf = (ip: string): string | null => (ip === '' ? null : truncateIp(addressOnly(ip)))

/** One click over the API. The address is a network; nothing here is an address. */
export function asClick(r: ClickRow): Record<string, unknown> {
  return {
    clickId: r.click_id,
    at: new Date(Number(r.at_ms)).toISOString(),
    host: r.host,
    path: r.path,
    domainId: r.domain_id,
    linkId: r.link_id,
    outcome: r.outcome,
    step: r.step,
    status: r.status,
    destination: none(r.destination),
    targetId: none(r.target_id),
    visitorId: r.visitor_id,
    returning: r.returning === 1,
    country: none(r.country),
    // Recorded from day one and empty until city-level lands, which is a
    // column that exists and a value that does not.
    region: none(r.region),
    city: none(r.city),
    geoSource: none(r.geo_source),
    device: r.device,
    os: none(r.os),
    browser: none(r.browser),
    // Zero is how a click with no known network is stored, and zero is not an
    // autonomous system number.
    asn: r.asn === 0 ? null : r.asn,
    class: none(r.traffic_class),
    signals: r.signals,
    action: none(r.action),
    referrer: none(r.referrer),
    userAgent: none(r.user_agent),
    // Null for a click whose address was blanked by the retention pass, and
    // null for anything the parser does not recognise: never the stored value.
    network: networkOf(r.ip),
    capUnchecked: r.cap_unchecked === 1,
  }
}

/**
 * The WHERE clause and its parameters. Every value is a parameter; what the
 * text carries is whether a clause is there at all.
 */
export function clickFilter(
  q: { class?: string; outcome?: string; country?: string },
  w: ReportWindow,
  cursor: { atMs: number; clickId: string } | null,
): { where: string; params: Record<string, unknown> } {
  const parts = [`time >= {from:DateTime64(3,'UTC')}`, `time < {to:DateTime64(3,'UTC')}`]
  const params: Record<string, unknown> = { from: w.from, to: w.to }
  if (w.linkId !== null) {
    parts.push('link_id = {link:UUID}')
    params.link = w.linkId
  }
  if (q.class !== undefined) {
    parts.push('traffic_class = {class:String}')
    params.class = q.class
  }
  if (q.outcome !== undefined) {
    parts.push('outcome = {outcome:String}')
    params.outcome = q.outcome
  }
  if (q.country !== undefined) {
    parts.push('country = {country:String}')
    params.country = q.country
  }
  if (cursor !== null) {
    // One tuple comparison rather than three clauses with an OR: the pair is
    // what the order is by, so the pair is what the boundary is on.
    parts.push(`(time, click_id) < ({cursorAt:DateTime64(3,'UTC')}, {cursorId:UUID})`)
    params.cursorAt = new Date(cursor.atMs).toISOString().replace('T', ' ').replace('Z', '')
    params.cursorId = cursor.clickId
  }
  return { where: parts.join(' AND '), params }
}

export function registerClickRoutes(app: FastifyInstance, ctx: AdminContext): void {
  /**
   * One page of the log, newest first.
   *
   * The window is used exactly as it was sent — to the millisecond, half-open —
   * unlike a report, which can only answer whole hours. Both say what they
   * counted, because the two answers over the same ragged window are allowed to
   * differ and an operator comparing them deserves to know why.
   */
  app.get('/api/clicks', async (req) => {
    requireCredential(req)
    const q = readQuery(ListQuery, req.query)
    const w = parseWindow(q, { alignMs: null })
    const cursor = q.cursor === undefined ? null : parseCursor(q.cursor)
    const ch = requireCh(ctx, req)
    return withSlot(
      ctx.reportGate,
      { code: 'too_many_reports', message: 'too many reports at once; try again' },
      async () => {
        const { where, params } = clickFilter(q, w, cursor)
        const rows = await chRows<ClickRow>({
          ch,
          req,
          query: `SELECT ${CLICK_COLUMNS} FROM clicks FINAL WHERE ${where}
                   ORDER BY time DESC, click_id DESC LIMIT ${q.limit + 1}`,
          params,
        })
        const page = rows.slice(0, q.limit)
        const last = page[page.length - 1]
        return {
          window: { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString() },
          link: w.linkId,
          clicks: page.map(asClick),
          // Present only when a further page exists, so a caller stops rather
          // than asking for ever.
          nextCursor: rows.length > q.limit && last ? `${last.at_ms}.${last.click_id}` : null,
        }
      },
    )
  })
}
