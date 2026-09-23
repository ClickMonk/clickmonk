import type { FastifyReply } from 'fastify'
import type { ZodError, ZodType } from 'zod'

/** The largest request body any admin route accepts. A link with 20 targets fits easily. */
export const MAX_BODY_BYTES = 64 * 1024
/** A cookie header longer than this is not read at all. */
const MAX_COOKIE_HEADER = 8192

/**
 * Every failure the API answers with. `code` is stable and meant to be
 * matched on; `message` is for a person and never carries a secret, a
 * password, a token, or the value of a field that might be one.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const fail = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): never => {
  throw new HttpError(status, code, message, headers)
}

/**
 * A body through a zod schema. Every schema is `.strict()`, so a field the
 * API does not know is a 400 rather than something quietly ignored — which is
 * what makes "no request field can express the scope of a write" checkable:
 * an `accountId` or `adminId` in a body fails here.
 */
export function readBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {})
  if (r.success) return r.data
  const issues = (r.error as ZodError).issues
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ')
  return fail(400, 'invalid_body', issues)
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.slice(0, MAX_COOKIE_HEADER).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return out
}

/**
 * Headers on every response, including every error.
 *
 * `no-store` because an admin response is never cacheable — a shared cache or
 * a browser's back button holding a session's answer is a leak. The rest are
 * the flat refusals: no framing, no sniffing, no referrer, and a policy that
 * loads nothing at all, since this service answers JSON; a UI served from
 * this host later is what would have to relax it.
 *
 * `Strict-Transport-Security` is set because the admin host is reached over
 * HTTPS only: its session cookie is `Secure`, so a browser would drop it on a
 * plain-HTTP answer, and Caddy redirects that host to HTTPS anyway.
 */
export function securityHeaders(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store')
  reply.header('x-content-type-options', 'nosniff')
  reply.header('x-frame-options', 'DENY')
  reply.header('referrer-policy', 'no-referrer')
  reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  reply.header('strict-transport-security', 'max-age=31536000')
}
