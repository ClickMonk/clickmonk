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
