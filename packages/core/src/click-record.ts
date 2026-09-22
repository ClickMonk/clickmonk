import { z } from 'zod'
import type { Outcome, Step } from './evaluate.js'

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** The longest request path the redirect serves and records; longer is a 414. */
export const MAX_PATH_LENGTH = 2048
/** The referrer is recorded up to this many characters. */
export const MAX_REFERRER_LENGTH = 2048

/**
 * One line of the spool. Version 1. The redirect writes it, the worker parses
 * it with this same schema before inserting, so a malformed or foreign line
 * is skipped rather than poisoning a batch.
 */
export const ClickRecordSchema = z
  .object({
    v: z.literal(1),
    clickId: z.string().uuid(),
    time: z.string().datetime({ offset: false }),
    host: z.string().max(253),
    path: z.string().max(MAX_PATH_LENGTH),
    domainId: z.string().uuid(),
    linkId: z.string().uuid(),
    outcome: z.enum([
      'target',
      'device',
      'returning',
      'root',
      'not_found',
      'unknown_domain',
      'expired',
      'capped',
      'country_blocked',
    ]),
    step: z.enum(['resolve', 'limits', 'country', 'destination']),
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
  })
  .strict()

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
