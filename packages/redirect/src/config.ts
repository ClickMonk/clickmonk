import { isIP } from 'node:net'
import { DEFAULT_SPOOL_DIR, formatConfigError } from '@clickmonk/core'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'

/** The names Fastify's proxy matcher expands to address ranges. */
const PROXY_RANGE_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal'])

/**
 * One trusted proxy: an address, a CIDR range, or a named range. A /0 is
 * refused: it trusts every client to name its own address. The matcher
 * would also throw on it at start, in a trace that names no variable.
 */
function isProxyEntry(entry: string): boolean {
  if (PROXY_RANGE_NAMES.has(entry)) return true
  const slash = entry.indexOf('/')
  if (slash < 0) return isIP(entry) !== 0
  const family = isIP(entry.slice(0, slash))
  const bits = entry.slice(slash + 1)
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return false
  const n = Number(bits)
  return n >= 1 && n <= (family === 4 ? 32 : 128)
}

const TrustedProxies = z
  .string()
  .default('127.0.0.1')
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  )
  .superRefine((entries, ctx) => {
    for (const e of entries) {
      if (!isProxyEntry(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `not an address, a range with a prefix of 1 or more, loopback, linklocal or uniquelocal: ${e}`,
        })
      }
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
  CLICKMONK_TRUSTED_PROXIES: TrustedProxies,
  CLICKMONK_IPDATA_DIR: z.string().min(1).default(DEFAULT_IPDATA_DIR),
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
  }
}
