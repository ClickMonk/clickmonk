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

/**
 * Rows one export writes at most, and the largest an install may set it to.
 *
 * The default sits just under the 1,048,576 rows a spreadsheet will open, which
 * is the ceiling that matters to the person the file is for. The other one is a
 * file's rather than the store's: ten million rows of click log is tens of
 * gigabytes, and an install asking for more has stopped asking for a spreadsheet.
 */
export const EXPORT_ROW_CAP = 1_000_000
export const MAX_EXPORT_ROW_CAP = 10_000_000

/**
 * How long one export may hold the only export slot while writing its body.
 *
 * **What it is for.** Nothing else bounds the body. `max_execution_time` bounds a
 * query that is executing; a query blocked writing into a socket nobody drains is
 * not executing, so neither it nor the client's request timeout ends it, and
 * Fastify's `connectionTimeout` is 0 by default. Measured before this existed: a
 * credentialed client that took the headers and then stopped reading held the slot
 * for eighty seconds and was still holding it — every later export answered 429 —
 * until its socket was destroyed. One leaked key and one request, and the operator
 * cannot download their own log, with nothing in the log to say why.
 *
 * **What it costs.** It is a deadline on the whole body, not an idle timer, so an
 * honest slow reader on a poor connection loses a large export: the default cap is
 * a million rows, which is a few hundred megabytes, and ten minutes of it is
 * roughly what a five-megabit link delivers. That reader gets a file of whole lines
 * that stops early inside a chunked body with no terminating chunk — the same thing
 * a store failure mid-stream gives them, and visible as a failed transfer rather
 * than a short file that looks complete. They can ask for a narrower window, or the
 * install can raise this. An unbounded hold has no such remedy, which is the trade.
 */
export const EXPORT_BODY_DEADLINE_MS = 600_000

/**
 * The cap, checked against the range it is bound into and not only its type.
 *
 * It reaches the query text as a `LIMIT`, and the probe's as `LIMIT cap + 1`, so
 * it is a caller value with a longer path: it comes from whoever built this
 * service, which on an install is configuration, which is a file an operator
 * edits. A fractional one is `LIMIT 3.5` and a negative one is a syntax error —
 * each one a store error that every export from then on would answer with, and
 * that the caller would be told is an install outage rather than a number
 * somebody typed. So it is refused here, at boot, naming the thing that is
 * wrong, which is the bargain `loadConfig` already makes for a bad port.
 *
 * The default goes through it too: a range nothing is checked against is a range
 * that can quietly stop containing the value it was written for.
 */
export function checkExportRowCap(cap: number): number {
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_EXPORT_ROW_CAP) {
    throw new Error(
      `exportRowCap: must be a whole number of rows from 1 to ${MAX_EXPORT_ROW_CAP}, not ${cap}`,
    )
  }
  return cap
}

/**
 * The CSV's columns, in order, by the same names the JSON uses: one vocabulary
 * for one resource in two representations.
 *
 * Written out rather than taken from an example row, and held to `asClick` by a
 * test that compares this list against the keys that mapper returns: a field
 * added to one and forgotten in the other is then a failure rather than a column
 * that quietly stopped being exported.
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

/**
 * `20260924T000000Z`: the instant as digits, with the colons a filename cannot
 * carry taken out.
 *
 * The filename is the window the caller asked for, so it is not free of the
 * request — what it is free of is anything the caller chose the *shape* of. Both
 * halves are numbers by the time they reach here: `parseWindow` has turned the
 * caller's text into milliseconds, and this formats those, so the only characters
 * that can appear are the ones `toISOString` produces.
 */
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
   * and would bound nothing. It is given back by `release` below, which every
   * path calls and which runs once. The gate is the export's own and not the
   * report gate, so that a download an operator started does not lock their
   * dashboard out.
   *
   * **What bounds the slot.** Two different things, because the slot is held
   * across two phases that fail differently. The probe is bounded by
   * `max_execution_time` and, outside it, by the client's own request timeout:
   * that one is a query this process is waiting for. The body is bounded by
   * `EXPORT_BODY_DEADLINE_MS`, a timer armed when the stream is handed over,
   * because **nothing else bounds it at all** — a query blocked writing into a
   * socket nobody drains is not executing, so no server-side execution bound
   * applies to it, and Fastify's `requestTimeout` does not bound a handler
   * either: a three-second handler was measured answering after 3,029 ms under a
   * one-second setting, and this handler has returned before most of the work
   * happens anyway. So the slot is held for the probe's bound plus this
   * deadline, and never for as long as a caller cares to keep a socket open.
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
    let released = false
    /**
     * The result set once there is one, as the one thing that has to be closed.
     * Typed by the method called on it rather than by the client's own result
     * type, which nothing else in this service names.
     */
    let result: { close: () => void } | null = null
    /** The body's deadline, once there is a body. Cleared by `release`. */
    let deadline: NodeJS.Timeout | null = null

    /**
     * Gives the slot back, once, from whichever path reaches it first.
     *
     * **Never conditioned on the body having been entered**, and this is the
     * whole point of it. When a caller hangs up before the first row is pulled,
     * Fastify destroys the stream and Node calls `return()` on a generator that
     * has not run a line — which completes it *without* running its `finally`.
     * A release that lived only there would therefore never happen, while
     * `started` had already told the handler's own `finally` to skip; both paths
     * skipped, and with one export slot in the process a single request and an
     * immediate close took the endpoint out until a restart. So the stream's
     * `close` and `error` release too, and this runs once because on an ordinary
     * export all three of them fire.
     *
     * Closing the result set is insurance rather than a measured need: whether
     * the store keeps working on a query nobody is reading was not established,
     * and closing one whose rows are already exhausted costs nothing.
     */
    const release = (): void => {
      if (released) return
      released = true
      // Before the slot goes back, and on every path: a timer left armed after
      // an export finished would fire against a stream that is already gone, and
      // would keep this process awake for the rest of the deadline.
      if (deadline !== null) clearTimeout(deadline)
      result?.close()
      ctx.exportGate.leave()
    }

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
      result = rows
      /**
       * The blocks, taken here rather than inside the generator, so that
       * `release` always has a pipeline to close: closing a result set nobody has
       * streamed destroys its response stream directly, and a destroyed stream
       * with nothing listening for an error takes the process down instead of
       * ending an export. Once this exists, the close is handled inside the
       * client's own pipeline.
       */
      const blocks = rows.stream<ClickRow>()
      // The error is handled where the rows are read, in the generator's `catch`.
      // This listener is for the case where nobody is reading them — a result set
      // closed after the caller hung up — which would otherwise be an uncaught
      // exception rather than a download that stopped.
      blocks.on('error', () => {})

      async function* body(): AsyncGenerator<string> {
        try {
          yield csvLine([...CSV_FIELDS])
          for await (const block of blocks) {
            for (const row of block) {
              // The same mapper the page of JSON uses, so the file carries the
              // network and never the address it was truncated from.
              const click = asClick(row.json())
              yield csvLine(CSV_FIELDS.map((f) => click[f]))
            }
          }
        } catch (err) {
          // **A download cannot be retracted.** The 200 and every header went
          // out before the first row, so there is no status left to change and
          // nothing honest to append. What the caller is left with is a file of
          // whole, well-formed lines that stops early — the rows written so far,
          // each one complete — inside a chunked body that never got its
          // terminating chunk, which is what makes the transfer an error the
          // client can see rather than a short file it cannot. Appending a last
          // line would throw that away: a file that ends cleanly with half the
          // rows missing is the one thing this endpoint exists not to produce.
          //
          // So this line is the only record that the file is short, which is why
          // it is at error level: an operator who reads it counts the rows, and
          // one who never sees it trusts a file that ends early. A failure
          // *before* the first byte is a different case — the probe's is a 503,
          // and the stream query's own is the error handler's 500.
          req.log.error({ err }, 'clickhouse failed while an export was streaming')
          throw err
        } finally {
          release()
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
      const file = Readable.from(body())
      // Both events, and neither is spare: `close` is what a stream destroyed
      // before it was ever read emits, and it is the only signal on that path;
      // `error` is a stream that failed, which on a hangup can arrive first.
      file.on('close', release)
      file.on('error', release)
      // The body's deadline, armed here because here is where the unbounded wait
      // begins. Destroying the stream is what ends it: that is the same path a
      // caller hanging up takes, so `close` fires and `release` gives the slot
      // back through the one function every path already goes through.
      //
      // The line is the only record that an export was cut off — the 200 and every
      // header went out before the first row, so there is no status left to change
      // — and it names the caller's behaviour rather than a fault here, because
      // that is what it is.
      deadline = setTimeout(() => {
        req.log.warn(
          { deadlineMs: ctx.exportDeadlineMs },
          'an export was cut off: the caller stopped reading its body',
        )
        file.destroy()
      }, ctx.exportDeadlineMs)
      started = true
      return reply.send(file)
    } finally {
      // Only when nothing downstream can release it any more — the probe failed,
      // say, and there is no stream. Once the stream exists, its own `close`
      // gives the slot back, and releasing here would give it back at the
      // beginning of the export.
      if (!started) release()
    }
  })
}
