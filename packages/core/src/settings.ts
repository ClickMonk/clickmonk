import { z } from 'zod'
import { isDestinationUrl } from './link.js'
import {
  DEFAULT_TRAFFIC_ACTIONS,
  NON_HUMAN_CLASSES,
  type TrafficActions,
  TrafficActionsSchema,
} from './traffic.js'

/**
 * Clicks per minute from one client above which it is an abuser, unless the admin
 * sets another. A client is what `rateKey` counts: one IPv4 address, or one IPv6
 * /64, because an IPv6 client usually holds a whole /64.
 */
export const DEFAULT_ABUSER_THRESHOLD = 60
export const MAX_ABUSER_THRESHOLD = 100_000

/** The install-wide settings the redirect evaluates with. */
export interface TrafficSettings {
  actions: TrafficActions
  /** Where the `safe` action sends a click. Takes tokens, like any destination. */
  safeUrl: string | null
  abuserThreshold: number
}

export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  actions: DEFAULT_TRAFFIC_ACTIONS,
  safeUrl: null,
  abuserThreshold: DEFAULT_ABUSER_THRESHOLD,
}

export const TrafficSettingsSchema = z
  .object({
    actions: TrafficActionsSchema,
    safeUrl: z
      .string()
      .refine(isDestinationUrl, {
        message:
          'must be an absolute http(s) URL of at most 2048 printable ASCII characters, with no token in the host',
      })
      .nullable(),
    abuserThreshold: z.number().int().min(1).max(MAX_ABUSER_THRESHOLD),
  })
  .strict()
  .superRefine((s, ctx) => {
    for (const c of NON_HUMAN_CLASSES) {
      if (s.actions[c] === 'safe' && s.safeUrl === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', c],
          message: 'the safe action needs a safe URL',
        })
      }
    }
  })

/** The longest either retention period may be set to: ten years. */
export const MAX_RETENTION_DAYS = 3650
/** How long raw clicks are kept unless the admin says otherwise. */
export const DEFAULT_RAW_RETENTION_DAYS = 90
/** And how long the whole IP address on one is kept. */
export const DEFAULT_IP_RETENTION_DAYS = 30

/**
 * How long this install keeps the two things it can stop keeping.
 *
 * **Null is forever**, for either. Zero was rejected as the forever value
 * because it reads equally as "drop everything now", and the difference
 * between those two readings is the whole table.
 *
 * Aggregates outlive both: the hourly rollups are never dropped, because they
 * are small and they are what answers a question older than the raw window.
 */
export interface RetentionSettings {
  /** Days of raw clicks. Null: kept for ever. */
  rawRetentionDays: number | null
  /** Days the whole address on a click is kept before it is blanked. Null: for ever. */
  ipRetentionDays: number | null
}

export const DEFAULT_RETENTION: RetentionSettings = {
  rawRetentionDays: DEFAULT_RAW_RETENTION_DAYS,
  ipRetentionDays: DEFAULT_IP_RETENTION_DAYS,
}

const RetentionDays = z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable()

export const RetentionSettingsSchema = z
  .object({ rawRetentionDays: RetentionDays, ipRetentionDays: RetentionDays })
  .strict()

/**
 * What the operator should be told about a pair that is legal but does not do
 * what it looks like: an IP period longer than the raw period never runs,
 * because the click is gone first.
 *
 * It is a note and not a refusal on purpose. A CHECK that required the IP
 * period to be the shorter one would refuse `raw = 10` on an install whose IP
 * period is 30 — the tightening direction — and an operator reducing what they
 * keep must never be the one who is refused.
 */
export function retentionNote(r: RetentionSettings): string | null {
  if (r.rawRetentionDays === null) return null
  if (r.ipRetentionDays !== null && r.ipRetentionDays <= r.rawRetentionDays) return null
  const kept = r.ipRetentionDays === null ? 'for ever' : `for ${r.ipRetentionDays} days`
  return `addresses are set to be kept ${kept} but clicks for ${r.rawRetentionDays} days, so an address goes when its click does, after ${r.rawRetentionDays} days`
}
