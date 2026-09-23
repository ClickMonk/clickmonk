import {
  DEFAULT_SPOOL_DIR,
  TrustedProxiesSchema,
  formatConfigError,
  normaliseHost,
} from '@clickmonk/core'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'

/**
 * The admin API's host name, as the `ask` check needs to know it: that name is
 * not a link domain, so it has no verified row, and without this the admin
 * interface could never get a certificate. Empty means there is none.
 */
const AdminHost = z
  .string()
  .default('')
  .transform((s) => s.trim())
  .superRefine((value, ctx) => {
    if (value !== '' && normaliseHost(value) !== value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not a lower-case host name without a port or scheme: ${value}`,
      })
    }
  })

const Schema = z.object({
  CLICKMONK_POSTGRES_URL: z.string().url(),
  CLICKMONK_SECRET: z.string().min(32, 'must be at least 32 characters'),
  CLICKMONK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CLICKMONK_INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(9091),
  CLICKMONK_SPOOL_DIR: z.string().min(1).default(DEFAULT_SPOOL_DIR),
  CLICKMONK_SPOOL_MAX_BYTES: z.coerce.number().int().min(1_048_576).default(5_368_709_120),
  CLICKMONK_SNAPSHOT_PATH: z.string().min(1).default('/var/lib/clickmonk/state/snapshot.json'),
  CLICKMONK_TRUSTED_PROXIES: TrustedProxiesSchema,
  CLICKMONK_IPDATA_DIR: z.string().min(1).default(DEFAULT_IPDATA_DIR),
  CLICKMONK_ADMIN_HOST: AdminHost,
})

export interface RedirectConfig {
  postgresUrl: string
  secret: string
  port: number
  internalPort: number
  spoolDir: string
  spoolMaxBytes: number
  snapshotPath: string
  trustedProxies: string[]
  ipdataDir: string
  /** Null when unset: `ask` then approves verified link domains only. */
  adminHost: string | null
}

export function loadConfig(env: NodeJS.ProcessEnv): RedirectConfig {
  const r = Schema.safeParse(env)
  if (!r.success) throw new Error(formatConfigError(r.error))
  const e = r.data
  return {
    postgresUrl: e.CLICKMONK_POSTGRES_URL,
    secret: e.CLICKMONK_SECRET,
    port: e.CLICKMONK_PORT,
    internalPort: e.CLICKMONK_INTERNAL_PORT,
    spoolDir: e.CLICKMONK_SPOOL_DIR,
    spoolMaxBytes: e.CLICKMONK_SPOOL_MAX_BYTES,
    snapshotPath: e.CLICKMONK_SNAPSHOT_PATH,
    trustedProxies: e.CLICKMONK_TRUSTED_PROXIES,
    ipdataDir: e.CLICKMONK_IPDATA_DIR,
    adminHost: e.CLICKMONK_ADMIN_HOST === '' ? null : e.CLICKMONK_ADMIN_HOST,
  }
}
