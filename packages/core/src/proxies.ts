import { isIP } from 'node:net'
import { z } from 'zod'

/**
 * Which addresses an `X-Forwarded-For` header is believed from. One
 * definition, used by every service that sits behind Caddy: the redirect,
 * whose rate counter and click record take the visitor's address, and the
 * admin API, whose sign-in limiter counts failures per client. Two copies of
 * this would eventually disagree, and the way it fails — every request
 * arriving as the proxy — looks like one shared client rather than a
 * configuration fault.
 */

/** The names Fastify's proxy matcher expands to address ranges. */
export const PROXY_RANGE_NAMES: ReadonlySet<string> = new Set([
  'loopback',
  'linklocal',
  'uniquelocal',
])

/**
 * One trusted proxy: an address, a CIDR range, or a named range. A /0 is
 * refused: it trusts every client to name its own address. The matcher
 * would also throw on it at start, in a trace that names no variable.
 */
export function isProxyEntry(entry: string): boolean {
  if (PROXY_RANGE_NAMES.has(entry)) return true
  const slash = entry.indexOf('/')
  if (slash < 0) return isIP(entry) !== 0
  const family = isIP(entry.slice(0, slash))
  const bits = entry.slice(slash + 1)
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return false
  const n = Number(bits)
  return n >= 1 && n <= (family === 4 ? 32 : 128)
}

/**
 * The environment variable, as a list. Every entry is validated here rather
 * than inside the proxy matcher, which throws at the first request with a
 * trace that names neither the value nor the variable it came from.
 */
export const TrustedProxiesSchema = z
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
