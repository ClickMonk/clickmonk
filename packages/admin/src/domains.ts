/**
 * Domains over the API, and the one thing this surface deliberately cannot
 * do: mark a domain verified.
 *
 * `verified` gates both serving and certificate issuance, and the only things
 * that may set it are a DNS check that found this install's token and
 * `clickmonk domain add --verified`, which is typed on the server by whoever
 * runs it. An API flag would be a second escape hatch, reachable over the
 * network, on the flag that decides whether a host name gets a certificate.
 *
 * Un-verifying is here, because it is the admin action the CLI deliberately
 * left out, and because a failing DNS check never revokes verification on its
 * own — a resolver outage must not take live links down — so taking a domain
 * off the air needs a path somebody asks for.
 * It takes the domain off the air — its links answer 404 — but a certificate
 * Caddy already holds is presented until it expires; what stops is the
 * renewal. The response says so.
 */
import {
  isDomainUrl,
  normaliseHost,
  verificationRecordName,
  verificationRecordValue,
} from '@clickmonk/core'
import {
  AdminHostDomainError,
  type DomainDnsStatus,
  checkDomain,
  createDomain,
  createResolver,
  recordDomainCheck,
} from '@clickmonk/worker/domains'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { fail, readBody } from './http.js'

/**
 * Domains listed at once. The cap stays and real paging waits for the UI, so
 * a listing that hit it says `truncated: true` rather than handing back a
 * prefix as if it were everything.
 */
export const MAX_DOMAINS_LISTED = 500

/**
 * Which domains need attention: every domain not verified at all, and every
 * verified domain whose last check did not find the token — *unless* no
 * check has ever passed for it, because then nothing changed: it is exactly
 * what `domain add --verified` describes on screen, verified by hand with no
 * TXT record, not a domain that stopped proving itself. One spelling, read by
 * the listing below and by the count `GET /api/status` answers, so "which
 * domains need attention" is never asked two ways that could answer
 * differently.
 */
export const ALERT_CONDITION = `(
  (c.status IS NULL OR c.status <> 'verified')
  AND NOT (d.verified AND c.passed_at IS NULL)
)`

/**
 * How long after a check the same domain may be checked again over the API,
 * and how many checks this process runs at once. The worker's scheduled pass
 * has its own interval; these are the bounds on the endpoint an authenticated
 * caller can loop.
 */
export const MIN_CHECK_INTERVAL_MS = 60_000
/** Re-exported so a reader of this module sees the number the context was built with. */
export { DNS_CHECKS_IN_FLIGHT as CHECKS_IN_FLIGHT } from './app.js'

const DomainUrl = z.string().refine(isDomainUrl, {
  message: 'must be an absolute http(s) URL of printable ASCII with no token',
})

const CreateBody = z
  .object({
    host: z.string().min(1).max(253),
    rootUrl: DomainUrl.nullable().default(null),
    notFoundUrl: DomainUrl.nullable().default(null),
  })
  .strict()

const PatchBody = z
  .object({
    rootUrl: DomainUrl.nullable().optional(),
    notFoundUrl: DomainUrl.nullable().optional(),
  })
  .strict()

interface DomainRow {
  id: string
  host: string
  verified: boolean
  root_url: string | null
  not_found_url: string | null
  verification_token: string
  status: DomainDnsStatus | null
  detail: string | null
  checked_at: Date | null
  passed_at: Date | null
}

const SELECT_DOMAINS = `SELECT d.id, d.host, d.verified, d.root_url, d.not_found_url,
                               d.verification_token, c.status, c.detail, c.checked_at, c.passed_at
                          FROM domains d
                          LEFT JOIN domain_dns_checks c ON c.domain_id = d.id`

function asDomain(d: DomainRow): Record<string, unknown> {
  return {
    id: d.id,
    host: d.host,
    verified: d.verified,
    rootUrl: d.root_url,
    notFoundUrl: d.not_found_url,
    // The token is published in DNS by design: it is not a secret, it is a
    // value nobody but this install chose.
    verificationRecord: {
      name: verificationRecordName(d.host),
      type: 'TXT',
      value: verificationRecordValue(d.verification_token),
    },
    lastCheck:
      d.checked_at === null
        ? null
        : { status: d.status, detail: d.detail, checkedAt: d.checked_at.toISOString() },
    passedAt: d.passed_at === null ? null : d.passed_at.toISOString(),
    // So the interface never re-derives the rule ALERT_CONDITION encodes: a
    // domain shown as verified by hand, with nothing to warn about, is one
    // that is verified and has never once passed a check.
    handVerified: d.verified && d.passed_at === null,
  }
}

async function domainById(ctx: AdminContext, id: string): Promise<DomainRow> {
  if (!z.string().uuid().safeParse(id).success) fail(404, 'not_found', 'no such domain')
  const r = await ctx.pg.query<DomainRow>(`${SELECT_DOMAINS} WHERE d.id = $1`, [id])
  const row = r.rows[0]
  if (!row) fail(404, 'not_found', 'no such domain')
  return row as DomainRow
}

export function registerDomainRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/domains', async (req) => {
    requireCredential(req)
    // One row past the cap, asked for and dropped, so `truncated` is exact
    // rather than "the page was full, so probably".
    const r = await ctx.pg.query<DomainRow>(
      `${SELECT_DOMAINS} ORDER BY d.host LIMIT ${MAX_DOMAINS_LISTED + 1}`,
    )
    return {
      domains: r.rows.slice(0, MAX_DOMAINS_LISTED).map(asDomain),
      truncated: r.rows.length > MAX_DOMAINS_LISTED,
    }
  })

  /**
   * Adds a domain through the one writer the CLI also uses, so the statement
   * that decides a new domain's `verified` exists once. This route never
   * passes `verified`, and the body it read cannot carry one.
   *
   * The host is normalised here as well as there, so a bad one is a 400 that
   * names the field rather than the writer's last-resort refusal.
   */
  app.post('/api/domains', async (req, reply) => {
    requireCredential(req)
    const body = readBody(CreateBody, req.body)
    const host = normaliseHost(body.host)
    if (!host) return fail(400, 'invalid_host', 'not a valid host name')
    let created: Awaited<ReturnType<typeof createDomain>>
    try {
      created = await createDomain(ctx.pg, {
        host,
        // This service's own configured host, which is the name the reverse
        // proxy sends here. The writer holds the rule; this passes what only
        // this process knows.
        adminHost: ctx.adminHost,
        rootUrl: body.rootUrl,
        notFoundUrl: body.notFoundUrl,
      })
    } catch (err) {
      // A conflict with how this install is configured, not a malformed body:
      // the name is a perfectly good host name and every link on it would be
      // stored, verified and then answered by this API instead of redirected.
      if (err instanceof AdminHostDomainError) {
        return fail(
          409,
          'host_is_admin_host',
          'that is the host name this API answers on, so links on it would never resolve',
        )
      }
      throw err
    }
    if (!created) return fail(409, 'host_taken', 'this install already has that domain')
    return reply.code(201).send(asDomain(await domainById(ctx, created.id)))
  })

  app.patch<{ Params: { id: string } }>('/api/domains/:id', async (req) => {
    requireCredential(req)
    // The body first: a malformed body is a 400 whether the id exists or not,
    // and resolving the id first would answer 404 and hide the real fault.
    const body = readBody(PatchBody, req.body)
    const existing = await domainById(ctx, req.params.id)
    const rootUrl = body.rootUrl === undefined ? existing.root_url : body.rootUrl
    const notFoundUrl = body.notFoundUrl === undefined ? existing.not_found_url : body.notFoundUrl
    await ctx.pg.query(
      'UPDATE domains SET root_url = $2, not_found_url = $3, updated_at = $4 WHERE id = $1',
      [existing.id, rootUrl, notFoundUrl, ctx.now()],
    )
    return asDomain(await domainById(ctx, existing.id))
  })

  app.delete<{ Params: { id: string } }>('/api/domains/:id', async (req) => {
    requireCredential(req)
    const existing = await domainById(ctx, req.params.id)
    // Its links, targets, counters and check row go with it: every one of
    // them references the domain with ON DELETE CASCADE.
    await ctx.pg.query('DELETE FROM domains WHERE id = $1', [existing.id])
    return { ok: true }
  })

  /**
   * Checks the DNS now rather than waiting for the worker's next pass, and
   * records the result through the same single writer the worker and the CLI
   * use, so a third copy of that SQL never exists. A check that finds the
   * token verifies the domain; one that does not leaves `verified` alone.
   *
   * Bounded two ways, both failing closed, because a credential is not a bound
   * and a leaked key is a credential. A re-check of the same domain inside
   * MIN_CHECK_INTERVAL_MS answers what is already stored rather than asking
   * again, and at most CHECKS_IN_FLIGHT checks run in this process at once —
   * so looping this endpoint costs a 429 per request instead of a DNS query
   * per request through the install's own resolvers.
   */
  app.post<{ Params: { id: string } }>('/api/domains/:id/check', async (req) => {
    requireCredential(req)
    const existing = await domainById(ctx, req.params.id)
    const now = ctx.now()
    if (
      existing.checked_at !== null &&
      now.getTime() - existing.checked_at.getTime() < MIN_CHECK_INTERVAL_MS
    ) {
      const waitMs = MIN_CHECK_INTERVAL_MS - (now.getTime() - existing.checked_at.getTime())
      // The stored result comes back with the refusal, so a caller that asked
      // twice still learns the answer; it just does not get a second query.
      return fail(
        429,
        'checked_recently',
        `this domain was checked less than ${Math.round(MIN_CHECK_INTERVAL_MS / 1000)} seconds ago; its last result was ${existing.status}`,
        { 'retry-after': String(Math.ceil(waitMs / 1000)) },
      )
    }
    if (!ctx.checkGate.tryEnter()) {
      fail(429, 'too_many_checks', 'too many DNS checks at once; try again', {
        'retry-after': '1',
      })
    }
    const resolver = (ctx.resolver ?? (() => createResolver(ctx.dnsServers ?? [])))()
    try {
      const result = await checkDomain(resolver, existing.host, existing.verification_token)
      await recordDomainCheck(ctx.pg, { id: existing.id, verified: existing.verified }, result, now)
      return { status: result.status, detail: result.detail }
    } finally {
      // Whoever hands a resolver to a check owns its lifetime.
      resolver.cancel()
      ctx.checkGate.leave()
    }
  })

  app.post<{ Params: { id: string } }>('/api/domains/:id/unverify', async (req) => {
    requireCredential(req)
    const existing = await domainById(ctx, req.params.id)
    await ctx.pg.query('UPDATE domains SET verified = false, updated_at = $2 WHERE id = $1', [
      existing.id,
      ctx.now(),
    ])
    return {
      ok: true,
      note: 'links on this domain now answer 404 and no certificate will be renewed for it; a certificate already issued is presented until it expires',
    }
  })

  /**
   * What the operator has to know: every domain whose last check did not find
   * the token, and every domain no check has reached yet — except a domain
   * verified by hand that has never once passed a check, which is not shown
   * here until it does (`ALERT_CONDITION`). Verification is never revoked
   * automatically, so a domain here may still be serving — that is the point
   * of showing it.
   *
   * Capped and counted exactly as the listing is: an operator shown a prefix
   * of what is wrong, with no sign that it was a prefix, is worse off than
   * one shown nothing.
   */
  app.get('/api/alerts', async (req) => {
    requireCredential(req)
    const r = await ctx.pg.query<DomainRow>(
      `${SELECT_DOMAINS}
        WHERE ${ALERT_CONDITION}
        ORDER BY d.host LIMIT ${MAX_DOMAINS_LISTED + 1}`,
    )
    return {
      truncated: r.rows.length > MAX_DOMAINS_LISTED,
      domains: r.rows.slice(0, MAX_DOMAINS_LISTED).map((d) => ({
        id: d.id,
        host: d.host,
        verified: d.verified,
        status: d.status ?? 'never_checked',
        detail: d.detail,
        checkedAt: d.checked_at?.toISOString() ?? null,
        passedAt: d.passed_at?.toISOString() ?? null,
        // Always false here: ALERT_CONDITION already excludes a hand-verified
        // domain that has never passed a check, so nothing this route lists
        // ever is one. Present anyway, so every domain shape in this API
        // carries the same fields.
        handVerified: d.verified && d.passed_at === null,
      })),
    }
  })
}
