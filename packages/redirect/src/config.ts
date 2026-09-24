import {
  AdminHostSchema,
  DEFAULT_SPOOL_DIR,
  TrustedProxiesSchema,
  formatConfigError,
} from '@clickmonk/core'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'

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
})

/**
 * Said once at boot when the admin host could not be read, and the whole of
 * what is said: the variable, what was ignored, and what still works.
 *
 * The value itself is never in it. An operator who has pasted the wrong line
 * into their `.env` may have pasted a password, and a log a support request
 * carries a copy of is the last place for one — naming the variable is enough
 * to fix it, and the schema that refuses the value is the same one the admin
 * service names on its own console.
 */
export const ADMIN_HOST_IGNORED =
  'CLICKMONK_ADMIN_HOST is not a bare lower-case host name and has been ignored (the value is not logged). Links are being served as usual. The certificate check will approve verified link domains only, so the admin interface cannot be given a certificate until this is corrected.'

/**
 * The admin host, read the way this service alone reads it: a value it cannot
 * parse is ignored rather than fatal.
 *
 * The admin service refuses to boot on the same value, and should: it cannot
 * answer for a name it cannot parse, and it already has a documented state for
 * having no name at all. This service is different, because it reads this
 * variable for exactly one purpose — telling the proxy that one name may have a
 * certificate — and a mistyped host name is not a reason to stop redirecting.
 * Under a restart policy the alternative is every link on the install down for
 * a capital letter, which inverts what this process is for. The proxy's own
 * configuration already makes this trade, staying bootable on an empty value.
 *
 * `null` for both an unset variable and an unreadable one: the certificate
 * check then approves verified link domains and nothing else, which is the same
 * state an install that has never configured an admin host runs in.
 */
function readAdminHost(raw: string | undefined): {
  adminHost: string | null
  adminHostIgnored: boolean
} {
  const parsed = AdminHostSchema.safeParse(raw)
  if (!parsed.success) return { adminHost: null, adminHostIgnored: true }
  return { adminHost: parsed.data === '' ? null : parsed.data, adminHostIgnored: false }
}

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
  /**
   * Null when unset, and null when the value could not be read: `ask` then
   * approves verified link domains only.
   */
  adminHost: string | null
  /**
   * True when there was a value and it could not be read, so the caller logs
   * `ADMIN_HOST_IGNORED` once at boot. False when the variable was unset, which
   * is an ordinary configuration and not something to warn about.
   */
  adminHostIgnored: boolean
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
    // Read outside the schema above, so that a value this service cannot parse
    // leaves it serving links instead of refusing to start.
    ...readAdminHost(env.CLICKMONK_ADMIN_HOST),
  }
}
