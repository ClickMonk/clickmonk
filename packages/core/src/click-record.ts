import { z } from 'zod'
import type { Outcome, Step } from './evaluate.js'
import { TRAFFIC_ACTIONS, TRAFFIC_CLASSES } from './traffic.js'

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** The longest request path the redirect serves and records; longer is a 414. */
export const MAX_PATH_LENGTH = 2048
/** The referrer is recorded up to this many characters. */
export const MAX_REFERRER_LENGTH = 2048

/** The fields every record version carries. */
const common = {
  clickId: z.string().uuid(),
  time: z.string().datetime({ offset: false }),
  host: z.string().max(253),
  path: z.string().max(MAX_PATH_LENGTH),
  domainId: z.string().uuid(),
  linkId: z.string().uuid(),
  status: z.number().int().min(100).max(599),
  destination: z.string().max(4096).nullable(),
  targetId: z.string().uuid().nullable(),
  visitorId: z.string().max(64),
  returning: z.boolean(),
  device: z.enum(['ios', 'android', 'desktop']),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  userAgent: z.string().max(512),
  referrer: z.string().max(MAX_REFERRER_LENGTH),
  ip: z.string().max(45),
  capUnchecked: z.boolean(),
}

const V1_OUTCOMES = [
  'target',
  'device',
  'returning',
  'root',
  'not_found',
  'unknown_domain',
  'expired',
  'capped',
  'country_blocked',
] as const
const V1_STEPS = ['resolve', 'limits', 'country', 'destination'] as const

/**
 * One line of the spool as the redirect wrote it before traffic
 * classification. The worker still reads it: a spool written before an
 * upgrade is shipped after it.
 */
export const ClickRecordV1Schema = z
  .object({
    v: z.literal(1),
    ...common,
    outcome: z.enum(V1_OUTCOMES),
    step: z.enum(V1_STEPS),
  })
  .strict()

/** A short lower-case name: an OS or browser family, or a signal. */
const Token = z.string().regex(/^[a-z0-9_]{1,24}$/)

/**
 * Version 2 adds the traffic class, every signal that fired, the action
 * applied, the OS and browser families and the ASN. Signals, OS and browser
 * are open strings rather than closed lists, so a new family or signal
 * needs no new version. The class, action, device, outcome and step lists
 * are fixed: adding a value to any of them requires a new record version, since
 * an older worker would read the new value as a malformed line and drop it.
 * A version the worker does not know is left in the spool for a worker that
 * does.
 */
export const ClickRecordV2Schema = z
  .object({
    v: z.literal(2),
    ...common,
    outcome: z.enum([...V1_OUTCOMES, 'blocked', 'safe'] as const),
    step: z.enum([...V1_STEPS, 'classify'] as const),
    trafficClass: z.enum(TRAFFIC_CLASSES),
    signals: z.array(Token).max(16),
    action: z.enum(TRAFFIC_ACTIONS).nullable(),
    os: Token,
    browser: Token,
    // ClickHouse stores it as UInt32 and would wrap a larger value silently.
    asn: z.number().int().min(0).max(0xffffffff).nullable(),
    geoSource: z.string().max(128),
  })
  .strict()

/** Every record version the worker ships. */
export const SpoolRecordSchema = z.discriminatedUnion('v', [
  ClickRecordV1Schema,
  ClickRecordV2Schema,
])
export const MAX_RECORD_VERSION = 2

export type ClickRecordV1 = z.infer<typeof ClickRecordV1Schema>
export type ClickRecordV2 = z.infer<typeof ClickRecordV2Schema>
export type SpoolRecord = z.infer<typeof SpoolRecordSchema>

/** The version the redirect writes. */
export const ClickRecordSchema = ClickRecordV2Schema
export type ClickRecord = z.infer<typeof ClickRecordSchema>

/**
 * The spool's file contract, shared by the redirect (writer) and the worker
 * (reader). The writer appends to `open-<pid>-<run id>-<seq>.part` and renames a full
 * or old segment to `segmentName(...)`; the reader takes only names matching
 * SEALED_SEGMENT_RE, so it never reads a segment still being written. The
 * zero-padded timestamp makes a plain string sort oldest-first.
 */
export const DEFAULT_SPOOL_DIR = '/var/lib/clickmonk/spool'
export const SEALED_SEGMENT_RE = /^seg-\d{15}-\d+-\d+\.ndjson$/

export function segmentName(epochMs: number, pid: number, seq: number): string {
  return `seg-${String(epochMs).padStart(15, '0')}-${pid}-${seq}.ndjson`
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _outcomes: Same<ClickRecord['outcome'], Outcome> = true
const _steps: Same<ClickRecord['step'], Step> = true
void _outcomes
void _steps
