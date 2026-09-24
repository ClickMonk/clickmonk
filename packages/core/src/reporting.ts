/**
 * The vocabulary a report is asked in: the two bucket sizes, the dimensions a
 * breakdown may name, and the bounds on a window.
 *
 * It is here rather than in the admin service because two files have to agree
 * on the dimension names — the one that parses a request and the one that
 * creates the rollup those names are keys of — and because none of it is I/O.
 *
 * **A window is half-open and UTC**: `from` is included, `to` is not, and
 * nothing here knows what "today" means. That is deliberate. A preset like
 * "last 7 days" needs a timezone; this install has no opinion about the
 * operator's, and a timezone parameter on five endpoints is five places to get
 * it wrong. A caller computes a preset into a pair of instants. The hourly
 * grain is what leaves a whole-hour offset possible later without a schema
 * change; a half-hour zone would need one.
 */

/** The two bucket sizes a chart is drawn at. */
export const REPORT_BUCKETS = ['hour', 'day'] as const
export type ReportBucket = (typeof REPORT_BUCKETS)[number]

/**
 * Readonly because `bucketCount` reads it on every call: an assignment to one
 * of these two fields anywhere in the process would change every bucket count
 * afterwards, and nothing would report it.
 */
export const BUCKET_MS: Readonly<Record<ReportBucket, number>> = {
  hour: 3_600_000,
  day: 86_400_000,
}

/**
 * Dimensions held as rows of the per-dimension rollup, one row per value that
 * actually occurred. Every one of them is open — a country list grows, a
 * browser family is a plain string, and a referrer host is whatever somebody
 * linked from — which is why they are rows rather than columns of a key.
 */
export const ROLLUP_DIMENSIONS = [
  'country',
  'device',
  'os',
  'browser',
  'referrer',
  'target',
] as const
export type RollupDimension = (typeof ROLLUP_DIMENSIONS)[number]

/**
 * Dimensions that are keys of the hourly rollup itself. All three are closed
 * lists whose values cannot grow without a new click record version, so keying
 * by them costs a bounded number of rows per hour and per link, and a summary
 * can be answered from one table.
 */
export const KEYED_DIMENSIONS = ['class', 'action', 'outcome'] as const
export type KeyedDimension = (typeof KEYED_DIMENSIONS)[number]

export const REPORT_DIMENSIONS = [...ROLLUP_DIMENSIONS, ...KEYED_DIMENSIONS] as const
export type ReportDimension = RollupDimension | KeyedDimension

/** Which of the two rollups answers this dimension. */
export function isKeyedDimension(d: ReportDimension): d is KeyedDimension {
  return (KEYED_DIMENSIONS as readonly string[]).includes(d)
}

/** The longest window any report answers for. */
export const MAX_REPORT_WINDOW_DAYS = 400
export const MAX_REPORT_WINDOW_MS = MAX_REPORT_WINDOW_DAYS * 86_400_000

/** The most buckets one chart response carries. */
export const MAX_REPORT_BUCKETS = 2000

/**
 * How many buckets the half-open window [fromMs, toMs) touches.
 *
 * Counted from aligned boundaries rather than from elapsed time: twenty
 * minutes either side of an hour boundary is forty minutes of elapsed time and
 * two bars on a chart, and a ceiling computed the other way would let a
 * response through that is one bar bigger than the ceiling. Unix time carries
 * no leap seconds, so a day boundary is exact arithmetic on the epoch.
 */
export function bucketCount(fromMs: number, toMs: number, bucket: ReportBucket): number {
  if (toMs <= fromMs) return 0
  const ms = BUCKET_MS[bucket]
  return Math.floor((toMs - 1) / ms) - Math.floor(fromMs / ms) + 1
}
