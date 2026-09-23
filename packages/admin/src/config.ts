import { TrustedProxiesSchema, formatConfigError, normaliseHost } from '@clickmonk/core'
import { isResolverAddress } from '@clickmonk/worker/domains'
import { z } from 'zod'

/**
 * The host name the admin API answers on, and nothing else. Empty is allowed
 * and means "not configured": the service starts and answers 503 on every
 * route, rather than refusing to boot, because it ships in the same Compose
 * stack as the redirect and an install that has not set it must still get its
 * links served.
 *
 * A name that is not a host name fails the configuration with the variable
 * named. Nothing here accepts a port or a scheme: it is compared against the
 * `Host` header of every request and used to build the one `Origin` the API
 * believes, and a value carrying `https://` would silently match nothing.
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

const DnsServers = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  )
  .superRefine((entries, ctx) => {
    for (const e of entries) {
      if (!isResolverAddress(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `not a resolver address, optionally with a port ([2001:db8::1]:53 for IPv6): ${e}`,
        })
      }
    }
  })

const Schema = z.object({
  CLICKMONK_POSTGRES_URL: z.string().url(),
  CLICKMONK_ADMIN_HOST: AdminHost,
  CLICKMONK_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  // The same list the redirect believes a forwarded address from, and for the
  // same reason: behind Caddy every request otherwise arrives from Caddy, so
  // the sign-in limiter would count every failure from every address as one.
  CLICKMONK_TRUSTED_PROXIES: TrustedProxiesSchema,
  // Used only by the on-demand domain check, which asks the same resolvers
  // the worker's scheduled pass does.
  CLICKMONK_DNS_SERVERS: DnsServers,
})

export interface AdminConfig {
  postgresUrl: string
  /** Null when unset: every route answers 503 until an operator names the host. */
  adminHost: string | null
  port: number
  trustedProxies: string[]
  dnsServers: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv): AdminConfig {
  const r = Schema.safeParse(env)
  if (!r.success) throw new Error(formatConfigError(r.error))
  const e = r.data
  return {
    postgresUrl: e.CLICKMONK_POSTGRES_URL,
    adminHost: e.CLICKMONK_ADMIN_HOST === '' ? null : e.CLICKMONK_ADMIN_HOST,
    port: e.CLICKMONK_ADMIN_PORT,
    trustedProxies: e.CLICKMONK_TRUSTED_PROXIES,
    dnsServers: e.CLICKMONK_DNS_SERVERS,
  }
}
