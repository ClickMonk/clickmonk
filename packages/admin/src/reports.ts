/**
 * Reports: what the rollups say about a window.
 *
 * Everything here is a read behind the credential this service already has —
 * a session or an API key, because a nightly export is a script and not a
 * browser — and none of it is a write, so the cross-site rule that guards a
 * write does not apply.
 *
 * **A credential is not a bound.** A caller who has one, or a key that has
 * leaked, can loop any of these, and each pass is a scan of a window they
 * chose. So a window is bounded — in length, and to the grain the rollups
 * answer at — and at most two of these run in this process at once; past that
 * the answer is a refusal with `retry-after` rather than a queued query. The
 * same argument as the on-demand DNS check, for the same reason.
 *
 * **A report counts whole hours.** The rollups are hourly, so `from` is
 * floored to the hour and `to` is raised to the next one, and the response
 * says which window was counted rather than echoing the one that was asked
 * for. The click log reads raw clicks and uses the window exactly as given;
 * the two can therefore differ over a ragged window, which is why both of them
 * say what they counted.
 */
import {
  BUCKET_MS,
  type ConcurrencyGate,
  MAX_REPORT_BUCKETS,
  MAX_REPORT_WINDOW_DAYS,
  MAX_REPORT_WINDOW_MS,
  REPORT_BUCKETS,
  type ReportBucket,
  bucketCount,
} from '@clickmonk/core'
import type { ClickHouseClient } from '@clickmonk/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { fail } from './http.js'

/** The server-side bound on one report query. Shorter than the client's own. */
export const CH_MAX_EXECUTION_SECONDS = 25

/**
 * The grain the rollups answer at, and so the alignment the summary counts in.
 * The chart aligns to its own bucket size instead. Exported for the suite,
 * which calls `parseWindow` directly and has to pass what a route would pass.
 */
export const HOUR_MS = 3_600_000

/**
 * The three fields every report query has. Spread into each route's own
 * schema rather than shared as a base object, so that each route stays
 * `.strict()` — a query parameter nobody knows is a 400 and not something
 * quietly ignored, which is what makes "no request field can widen what is
 * read" checkable on a surface that has nothing to widen to yet.
 */
/** A link filter is a link id and nothing else. Checked here and in the parser. */
const LinkId = z.string().uuid()

export const WINDOW_FIELDS = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  link: LinkId.optional(),
}

export interface ReportWindow {
  fromMs: number
  toMs: number
  /** The same two instants in ClickHouse's own text form. */
  from: string
  to: string
  linkId: string | null
}

const chTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

/**
 * A window from a parsed query. `alignMs` floors the start and raises the end
 * to a multiple of itself — an hour for the summary, the bucket size for the
 * chart, because that is the grain each of them can actually answer. The log
 * passes null and gets the instants as they were sent.
 *
 * The bound is on the window that will actually be read, so it is measured
 * after alignment: a caller must not be able to buy an extra bucket of scan by
 * asking for a ragged window one millisecond inside the ceiling.
 *
 * The two bounds do not compose, either: four hundred days of hourly buckets
 * is 9,600 of them against a ceiling of 2,000, and the ceiling bites first
 * from about 84 days on. Whatever asks for buckets checks its own count; what
 * this function owes it is a window made of numbers.
 */
export function parseWindow(
  q: { from: string; to: string; link?: string },
  o: { alignMs: number | null },
): ReportWindow {
  const rawFrom = Date.parse(q.from)
  const rawTo = Date.parse(q.to)
  const align = o.alignMs
  const fromMs = align === null ? rawFrom : Math.floor(rawFrom / align) * align
  const toMs = align === null ? rawTo : Math.ceil(rawTo / align) * align
  // `!(toMs > fromMs)` and not `toMs <= fromMs`: every comparison with NaN is
  // false, so the second form lets an unparseable date through, and NaN then
  // survives the alignment, the length check and the bucket ceiling — each of
  // which compares with `>` and is therefore also false. The double negative is
  // the guard. Do not simplify it.
  if (!(toMs > fromMs)) {
    return fail(400, 'invalid_query', 'to: must be after from')
  }
  if (toMs - fromMs > MAX_REPORT_WINDOW_MS) {
    return fail(400, 'window_too_long', `a window may be at most ${MAX_REPORT_WINDOW_DAYS} days`)
  }
  // The shape of the link, here and not only in a route's schema, for the same
  // reason the length is here: this value is bound into a query as a UUID, so a
  // caller who reaches this function without that schema turns a bad request
  // into a store error — a 503 that says reporting is unavailable when what is
  // actually wrong is the one field the caller sent.
  if (q.link !== undefined && !LinkId.safeParse(q.link).success) {
    return fail(400, 'invalid_query', 'link: must be a link id')
  }
  return {
    fromMs,
    toMs,
    from: chTime(fromMs),
    to: chTime(toMs),
    linkId: q.link ?? null,
  }
}

/** A parsed query, or a 400 that names the field. Query strings, not bodies. */
export function readQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const r = schema.safeParse(query ?? {})
  if (r.success) return r.data
  const issues = r.error.issues
    .map((i) => `${i.path.join('.') || 'query'}: ${i.message}`)
    .join('; ')
  return fail(400, 'invalid_query', issues)
}

/**
 * The client, or a 503. Not having one at all and not being able to reach one
 * are the same answer to a caller: reporting is not available on this install
 * right now. They are different lines in the log.
 */
export function requireCh(ctx: AdminContext, req: FastifyRequest): ClickHouseClient {
  if (!ctx.ch) {
    req.log.error('a report was asked for but this service has no clickhouse client')
    // `return fail(…)`, never a bare call. `fail` is a const arrow with no
    // annotation on the variable, so TypeScript does not treat the call as
    // never-returning and does not narrow `ctx.ch` away from undefined; a bare
    // call leaves the line below as `ClickHouseClient | undefined`. The link
    // routes carry a comment saying the same thing, for the same reason.
    return fail(503, 'reporting_unavailable', 'reporting is not available on this install')
  }
  return ctx.ch
}

/**
 * One query, as rows.
 *
 * Every value is a bound parameter; the only thing built into the text is a
 * clause that is present or absent, never a value. A failure is a 503 and a
 * server-side log line: an unreachable or overloaded store is the install's
 * state rather than a fault in the request, and `{"error":"internal"}` would
 * tell the operator nothing they could act on. Nothing ClickHouse said reaches
 * the caller — an error body can carry a table name, a column, or the address
 * of the server.
 */
export async function chRows<T>(o: {
  ch: ClickHouseClient
  req: FastifyRequest
  query: string
  params: Record<string, unknown>
}): Promise<T[]> {
  try {
    const rs = await o.ch.query({
      query: o.query,
      query_params: o.params,
      format: 'JSONEachRow',
      clickhouse_settings: { max_execution_time: CH_MAX_EXECUTION_SECONDS },
    })
    return await rs.json<T>()
  } catch (err) {
    o.req.log.error({ err }, 'clickhouse query failed')
    return fail(503, 'reporting_unavailable', 'reporting is not available on this install')
  }
}

/** Takes a slot, or refuses. Always gives it back. */
export async function withSlot<T>(
  gate: ConcurrencyGate,
  o: { code: string; message: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!gate.tryEnter()) {
    return fail(429, o.code, o.message, { 'retry-after': '1' })
  }
  try {
    return await fn()
  } finally {
    gate.leave()
  }
}

/** UInt64 comes back as a decimal string; every count here fits a double many times over. */
const count = (v: string | number | undefined): number => Number(v ?? 0)

/**
 * The newest hour the rollup holds, as an instant — or null when it holds none.
 *
 * `max()` with no `GROUP BY` answers one row whatever the range, and over no
 * rows that row is the zero of the column's type: `1970-01-01 00:00:00`, which
 * is not an hour any install had. An empty install must say "nothing yet"
 * rather than name the epoch, so the sentinel is read here. A separate function
 * because the branch is otherwise reachable only from a suite that owns the
 * whole table.
 */
export function newestHourOrNull(text: string | undefined): string | null {
  if (!text || text.startsWith('1970')) return null
  return `${text.replace(' ', 'T')}.000Z`
}

/** The window clause every report shares, with the link filter only when there is one. */
export function windowClause(w: ReportWindow, column = 'hour'): string {
  const parts = [`${column} >= {from:DateTime64(3,'UTC')}`, `${column} < {to:DateTime64(3,'UTC')}`]
  if (w.linkId !== null) parts.push('link_id = {link:UUID}')
  return parts.join(' AND ')
}

export function windowParams(w: ReportWindow): Record<string, unknown> {
  return { from: w.from, to: w.to, ...(w.linkId === null ? {} : { link: w.linkId }) }
}

const SummaryQuery = z.object({ ...WINDOW_FIELDS }).strict()

/**
 * How each bucket size is grouped. A module constant per bucket rather than
 * anything built from the request: the value that reaches the query text is
 * one of exactly two strings written here.
 */
const BUCKET_EXPR: Record<ReportBucket, string> = {
  hour: 'hour',
  day: 'toStartOfDay(hour)',
}

const TimeseriesQuery = z.object({ ...WINDOW_FIELDS, bucket: z.enum(REPORT_BUCKETS) }).strict()

export function registerReportRoutes(app: FastifyInstance, ctx: AdminContext): void {
  /**
   * The numbers at the top of a dashboard: how many clicks, how many people,
   * and how they broke down by the three closed dimensions.
   *
   * Three queries rather than one. The totals cannot be summed from the
   * grouped rows — a click belongs to exactly one (class, action, outcome)
   * triple so its count can be added up, but a visitor appears under as many
   * triples as they have clicks, and adding those gives a number larger than
   * the number of people. The third is the freshness of the whole install,
   * which is not about this window at all.
   */
  app.get('/api/reports/summary', async (req) => {
    requireCredential(req)
    const q = readQuery(SummaryQuery, req.query)
    const w = parseWindow(q, { alignMs: HOUR_MS })
    const ch = requireCh(ctx, req)
    return withSlot(
      ctx.reportGate,
      { code: 'too_many_reports', message: 'too many reports at once; try again' },
      async () => {
        const where = windowClause(w)
        const params = windowParams(w)
        const grouped = await chRows<{
          traffic_class: string
          action: string
          outcome: string
          clicks: string
        }>({
          ch,
          req,
          query: `SELECT traffic_class, action, outcome, uniqExactMerge(clicks_state) AS clicks
                    FROM clicks_hourly WHERE ${where}
                   GROUP BY traffic_class, action, outcome`,
          params,
        })
        const [totals] = await chRows<{ clicks: string; visitors: string }>({
          ch,
          req,
          query: `SELECT uniqExactMerge(clicks_state) AS clicks,
                         uniqExactMerge(visitors_state) AS visitors
                    FROM clicks_hourly WHERE ${where}`,
          params,
        })
        const [newest] = await chRows<{ newest: string }>({
          ch,
          req,
          query: 'SELECT toString(max(hour)) AS newest FROM clicks_hourly',
          params: {},
        })

        const add = (into: Record<string, number>, key: string, n: number): void => {
          into[key] = (into[key] ?? 0) + n
        }
        const byClass: Record<string, number> = {}
        const byAction: Record<string, number> = {}
        const byOutcome: Record<string, number> = {}
        for (const row of grouped) {
          const n = count(row.clicks)
          add(byClass, row.traffic_class, n)
          add(byAction, row.action, n)
          add(byOutcome, row.outcome, n)
        }

        return {
          window: { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString() },
          link: w.linkId,
          // The `?.` on both of these is the type of an array index under
          // `noUncheckedIndexedAccess`, not a guard against a missing row: an
          // aggregate with no `GROUP BY` answers exactly one row even over an
          // empty range, which the suite pins directly. The zeroes an empty
          // window gives back are ClickHouse's, not a fallback of ours.
          clicks: count(totals?.clicks),
          visitors: count(totals?.visitors),
          byClass,
          byAction,
          byOutcome,
          newestHour: newestHourOrNull(newest?.newest),
        }
      },
    )
  })

  /**
   * The chart: one row per bucket, with the empty ones filled in.
   *
   * Filled in this process rather than by ClickHouse's `WITH FILL`. It is not
   * one loop doing both jobs: the count is `bucketCount` in the shared
   * vocabulary and the fill is the loop below, two expressions that can be
   * changed apart. What holds them to each other is that both walk the same
   * half-open `[fromMs, toMs)` a `step` at a time from the same aligned bounds,
   * and what notices when they stop agreeing is the test at exactly the
   * ceiling: it asks for a window that counts 2,000 buckets and asserts 2,000
   * came back. `WITH FILL` would put the filling in a query and leave the
   * ceiling here, where no test can hold the two together at all.
   *
   * Two queries under one slot, and a slot is held for their sum: the buckets,
   * and the freshness of the whole install, which is not about this window.
   *
   * The bucket count is checked here and not by `parseWindow`, because the two
   * bounds do not compose: four hundred days is inside the window bound and
   * 9,600 hourly buckets, nearly five times the ceiling. The window bound alone
   * would let that through.
   *
   * A visitor is merged per bucket and never summed across buckets: somebody
   * who clicked at ten and at eleven is two hourly visitors and one daily one,
   * and both of those are the right answer to their own question.
   */
  app.get('/api/reports/timeseries', async (req) => {
    requireCredential(req)
    const q = readQuery(TimeseriesQuery, req.query)
    const step = BUCKET_MS[q.bucket]
    const w = parseWindow(q, { alignMs: step })
    const buckets = bucketCount(w.fromMs, w.toMs, q.bucket)
    if (buckets > MAX_REPORT_BUCKETS) {
      // `return fail(…)` rather than a bare call, for the reason `requireCh`
      // spells out: `fail` is a const arrow, so TypeScript does not treat a
      // bare call as ending the path.
      return fail(
        400,
        'too_many_buckets',
        `that window is ${buckets} buckets and at most ${MAX_REPORT_BUCKETS} are returned; ask for bucket=day or a shorter window`,
      )
    }
    const ch = requireCh(ctx, req)
    return withSlot(
      ctx.reportGate,
      { code: 'too_many_reports', message: 'too many reports at once; try again' },
      async () => {
        // The alias is `at` and not `hour`: an alias that shadows the column
        // would be what the `WHERE` below reads, and a string where a DateTime
        // belongs fails with an illegal-type error.
        const rows = await chRows<{ at: string; clicks: string; visitors: string }>({
          ch,
          req,
          query: `SELECT toString(${BUCKET_EXPR[q.bucket]}) AS at,
                         uniqExactMerge(clicks_state) AS clicks,
                         uniqExactMerge(visitors_state) AS visitors
                    FROM clicks_hourly WHERE ${windowClause(w)}
                   GROUP BY at ORDER BY at`,
          params: windowParams(w),
        })
        // The same freshness the summary answers with, and a chart needs it
        // more than a number does. Every bucket the rollup has no row for is
        // drawn as a zero, so a window running past the newest hour the install
        // holds is a run of real-looking zeroes with nothing in the response to
        // tell "nothing shipped yet" from "nobody clicked" — and a picture that
        // cannot say how fresh it is gets read as current. The whole table, not
        // this window, which is the question it answers.
        const [newest] = await chRows<{ newest: string }>({
          ch,
          req,
          query: 'SELECT toString(max(hour)) AS newest FROM clicks_hourly',
          params: {},
        })
        // Two formatters produce this key and the slice is what makes them
        // agree: ClickHouse's `toString` of a DateTime is nineteen characters,
        // `chTime` adds milliseconds. Checked against a running store rather
        // than assumed, because a key that never matched would draw every
        // bucket as a zero and every assertion about the length would pass.
        const found = new Map(rows.map((row) => [row.at, row]))
        const out: { at: string; clicks: number; visitors: number }[] = []
        // `at < w.toMs`, matching the half-open clause the query ran with: the
        // bucket the window's end names belongs to the next window, and filling
        // it here would draw a bar two adjacent charts both claim.
        for (let at = w.fromMs; at < w.toMs; at += step) {
          const row = found.get(chTime(at).slice(0, 19))
          out.push({
            at: new Date(at).toISOString(),
            clicks: count(row?.clicks),
            visitors: count(row?.visitors),
          })
        }
        return {
          window: { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString() },
          link: w.linkId,
          bucket: q.bucket,
          buckets: out,
          newestHour: newestHourOrNull(newest?.newest),
        }
      },
    )
  })
}
