/**
 * The raw click log, as a page of JSON and as a file.
 *
 * Two representations of one resource rather than two endpoints: the filters,
 * the column list, the dedup and the truncation are written once here and both
 * readers use them, so a rule about what an operator may see cannot come to be
 * stated differently in the download than in the page.
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
 * `network` cannot be misread. The rule it makes checkable is about click data:
 * no response built from a click carries a whole address, or a field called
 * `ip`, on any route — which is a property of the surface rather than of this
 * module, and what the check exists to catch is a route added later that selects
 * a click's `ip` and forgets to truncate it.
 *
 * It is **not** a claim that no response names a whole address. `GET
 * /api/sessions` hands the operator the addresses their own sessions were opened
 * from, whole and deliberately, because that is how they recognise their own
 * devices. The difference is whose address it is: a visitor never consented to
 * being in an operator's log, and the operator is looking at themselves.
 *
 * The truncation itself is `truncateIp`, and it is never done in SQL: a rule
 * about what an operator may see is stated once, in one place, so that a second
 * reader of these rows cannot come to state it differently.
 */
import { Readable } from 'node:stream'
import { OUTCOMES, TRAFFIC_CLASSES } from '@clickmonk/core'
import { addressOnly, truncateIp } from '@clickmonk/ipdata'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { csvLine } from './csv.js'
import { fail } from './http.js'
import {
  CH_MAX_EXECUTION_SECONDS,
  MAX_STORE_MS,
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
 *
 * Exported, with the column list and the row mapper below, so that a second
 * reader of these rows filters and maps them with this module's rules rather
 * than with its own. The export below is that second reader, and it takes these
 * fields and no others: a page size and a cursor are how a page of JSON is
 * walked and mean nothing to a file.
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
 * Opaque to the caller, and parsed strictly — it reaches a comparison against a
 * `DateTime64` and a `UUID`, so the pattern refuses anything that is not those
 * two shapes and `MAX_STORE_MS` refuses an instant outside what the first of
 * them holds.
 *
 * That range is the window's, imported rather than written out again here: one
 * fact about what the store can hold, in one place, because a second spelling of
 * it is how the two come to disagree. What the store does either side of it — a
 * clamp below year 10000 and a refused parameter above — is why the check
 * exists, and the constant's own comment says it.
 */
const CURSOR_RE = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseCursor(value: string): { atMs: number; clickId: string } {
  const m = CURSOR_RE.exec(value)
  // `return fail(…)`: a bare call does not narrow `m`, because `fail` is a
  // const arrow rather than a declaration. With the return, the lines below see
  // a match; the casts are for the index signature, which does not know the
  // pattern has two groups.
  if (!m) return fail(400, 'invalid_query', 'cursor: not a cursor from a previous page')
  const atMs = Number(m[1] as string)
  // The pattern's digits are unsigned, so the oldest instant a cursor can name
  // is the epoch, which is inside the type's range: only the newest end is
  // reachable and only it is checked.
  if (atMs > MAX_STORE_MS) {
    return fail(400, 'invalid_query', 'cursor: names an instant no click can have')
  }
  return { atMs, clickId: m[2] as string }
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
 * The columns the log selects, exported for the reason the filter fields are.
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
 * not bare address text, and the stored column is a plain `String` that the
 * record schema bounds only in length, so a click recorded through a proxy that
 * spelled the address `[2001:db8::5]:443` would otherwise read as "no network"
 * rather than as the /64 it came from.
 *
 * What is left after that reads as nothing, and there is no better answer to
 * give. A zone-suffixed address or a dotted quad with leading zeros is not
 * something this parser will take, and the only other value to hand over is the
 * stored one, which is the whole address. So a null here means one of two things
 * and the response does not tell them apart, because the row does not either:
 * the column was blanked by the retention pass, or whatever wrote the row was
 * not this redirect. The empty string a blanked column holds is among the values
 * `truncateIp` already refuses, so it needs no branch of its own.
 */
const networkOf = (ip: string): string | null => truncateIp(addressOnly(ip))

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
    // Null for a click whose address was blanked by the retention pass, and null
    // for anything the parser does not recognise. Never the stored value.
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

/** Rows one export writes at most. */
export const EXPORT_ROW_CAP = 1_000_000

/**
 * The CSV's columns, in order, by the same names the JSON uses: one vocabulary
 * for one resource in two representations.
 *
 * Written out rather than taken from an example row, so that a field added to
 * `asClick` and forgotten here is a failing test rather than a column that
 * quietly stopped being exported.
 */
export const CSV_FIELDS = [
  'clickId',
  'at',
  'host',
  'path',
  'domainId',
  'linkId',
  'outcome',
  'step',
  'status',
  'destination',
  'targetId',
  'visitorId',
  'returning',
  'country',
  'region',
  'city',
  'geoSource',
  'device',
  'os',
  'browser',
  'asn',
  'class',
  'signals',
  'action',
  'referrer',
  'userAgent',
  'network',
  'capUnchecked',
] as const

const ExportQuery = z.object({ ...CLICK_FILTER_FIELDS }).strict()

/** `20260924T000000Z`: a filename with no colons and nothing from the request in it. */
const stamp = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

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

  /**
   * The log as a file.
   *
   * A year of clicks is a file this process must never hold, so the rows are
   * read from the store a block at a time and written out a row at a time. The
   * response therefore has no `content-length`: a body with one is a body
   * somebody buffered.
   *
   * **Its own gate, taken by hand.** The handler returns as soon as the stream
   * is handed to Fastify, while the body is still being written, so a slot
   * released in a `finally` around this handler — which is what `withSlot` does
   * — would be given back at the beginning of the export rather than at the end
   * and would bound nothing. It is given back in the generator's own `finally`,
   * which runs whether the stream ended, failed, or the client hung up. The gate
   * is the export's own and not the report gate, so that a download an operator
   * started does not lock their dashboard out.
   *
   * **What bounds the slot.** `max_execution_time` on both statements, and
   * nothing else: Fastify's `requestTimeout` does not bound a handler — a
   * three-second handler was measured answering after 3,029 ms under a
   * one-second setting — and the handler has returned before most of this work
   * happens anyway. The slot is held for the probe plus the export, so it is
   * held for the sum of the two bounds; a client that reads slowly holds it
   * until the store ends the query, which is why the ceiling on how many run at
   * once is one.
   *
   * **Why a probe query.** An export cut at the cap says so in a header, and a
   * header has to be decided before the first byte of the body. A trailer would
   * be the obvious answer and is not one: `curl` does not show trailers and most
   * clients drop them. So one query asks whether there is a row past the cap,
   * which stops as soon as it has found cap + 1 rows and therefore costs no more
   * than the export it precedes.
   */
  app.get('/api/clicks.csv', async (req, reply) => {
    requireCredential(req)
    const q = readQuery(ExportQuery, req.query)
    const w = parseWindow(q, { alignMs: null })
    const ch = requireCh(ctx, req)
    const cap = ctx.exportRowCap

    // Every refusal above this line is answered before a slot is taken and
    // before a byte of a file exists: a bad field, a window the store cannot
    // hold and a missing credential are all JSON, with no `content-disposition`
    // on them.
    if (!ctx.exportGate.tryEnter()) {
      // `return fail(…)`, never a bare call: `fail` is a const arrow, so
      // TypeScript does not treat a bare call as ending the path.
      return fail(429, 'too_many_exports', 'an export is already running; try again', {
        'retry-after': '1',
      })
    }
    let started = false
    try {
      const { where, params } = clickFilter(q, w, null)
      const [probe] = await chRows<{ n: string }>({
        ch,
        req,
        query: `SELECT count() AS n FROM (SELECT 1 FROM clicks FINAL WHERE ${where} LIMIT ${cap + 1})`,
        params,
      })
      const truncated = Number(probe?.n ?? 0) > cap

      // Not through `chRows`, which waits for every row and hands back an
      // array. This one is read a block at a time below, and carries the same
      // server-side bound.
      const rows = await ch.query({
        query: `SELECT ${CLICK_COLUMNS} FROM clicks FINAL WHERE ${where}
                 ORDER BY time DESC, click_id DESC LIMIT ${cap}`,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: CH_MAX_EXECUTION_SECONDS },
      })

      async function* body(): AsyncGenerator<string> {
        try {
          yield csvLine([...CSV_FIELDS])
          for await (const block of rows.stream<ClickRow>()) {
            for (const row of block) {
              // The same mapper the page of JSON uses, so the file carries the
              // network and never the address it was truncated from.
              const click = asClick(row.json())
              yield csvLine(CSV_FIELDS.map((f) => click[f]))
            }
          }
        } catch (err) {
          // The status and the headers are long gone. Ending the connection
          // without a well-formed last line is the only honest thing left: a
          // 200 that ends in a complete-looking file with half the rows missing
          // is exactly what this endpoint exists not to do.
          req.log.error({ err }, 'clickhouse failed while an export was streaming')
          throw err
        } finally {
          ctx.exportGate.leave()
        }
      }

      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header(
        'content-disposition',
        `attachment; filename="clicks-${stamp(w.fromMs)}-${stamp(w.toMs)}.csv"`,
      )
      reply.header('x-clickmonk-row-cap', String(cap))
      // Before the body, which is the whole reason for the probe above.
      reply.header('x-clickmonk-truncated', truncated ? 'true' : 'false')
      started = true
      return reply.send(Readable.from(body()))
    } finally {
      // Only when the generator never took ownership of the slot — the probe
      // failed, say. Once the stream is handed over, its own `finally` is what
      // gives it back.
      if (!started) ctx.exportGate.leave()
    }
  })
}
