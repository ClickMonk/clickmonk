import { AttemptCounter, ConcurrencyGate, normaliseHost } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import type { DomainResolver } from '@clickmonk/worker/domains'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { type Credential, authenticate, checkCsrf, hasBearer } from './auth.js'
import { HttpError, MAX_BODY_BYTES, securityHeaders } from './http.js'
import { registerSessionRoutes } from './session-routes.js'

/** Failed sign-ins from one address before it is refused, and the window. */
export const LOGIN_ATTEMPT_LIMIT = 10
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
/** Password checks this process runs at once. */
export const PASSWORD_CHECKS_IN_FLIGHT = 2
/**
 * On-demand DNS checks this process runs at once. Declared here rather than in
 * the domain module because the context is built here and whatever adds a
 * bound must not have to reach back into this file for the number.
 */
export const DNS_CHECKS_IN_FLIGHT = 2

export interface AdminDeps {
  pg: Pool
  /**
   * The one host name this service answers on. Null: not configured, and
   * every route answers 503 — the service still starts, because it ships in
   * the same stack as the redirect and an install that never sets this must
   * still serve its links.
   */
  adminHost: string | null
  now?: () => Date
  /**
   * The clock the attempt counter is keyed on: monotonic, and never the wall
   * clock. `ctx.now()` decides what goes in a row and what a lockout expires
   * at; this decides when an attempt window turns over. They are different
   * jobs and a wall clock walked backwards must not be able to do the second
   * one — that would clear a lockout. Injected so a test can move it.
   */
  monotonic?: () => number
  /**
   * Builds the resolver the on-demand domain check asks. Whoever hands a
   * resolver to a check owns its lifetime, so one is built per request and
   * cancelled after it.
   */
  resolver?: () => DomainResolver
  /** Resolver addresses for the on-demand check; the host's own when empty. */
  dnsServers?: string[]
  /**
   * The two bounds in front of every password check, injectable so a test can
   * shrink one below the others and show that *this* bound decided. A limiter
   * test that cannot reach its own bound before the account lockout fires is a
   * test that pins nothing.
   */
  loginAttempts?: AttemptCounter
  passwordGate?: ConcurrencyGate
  checkGate?: ConcurrencyGate
  /** `false` silences Fastify's logger (tests); omitted, it logs. */
  log?: false
}

export interface AdminContext extends AdminDeps {
  now: () => Date
  monotonic: () => number
  loginAttempts: AttemptCounter
  passwordGate: ConcurrencyGate
  /** How many on-demand DNS checks this process runs at once. */
  checkGate: ConcurrencyGate
}

declare module 'fastify' {
  interface FastifyRequest {
    credential?: Credential
  }
}

/** The address a limiter counts by: the visitor's, through Caddy. */
export function clientAddress(req: FastifyRequest): string {
  return (req.ip ?? '').slice(0, 45)
}

export function buildAdminApp(
  deps: AdminDeps,
  opts: { trustProxy: string | string[] | boolean },
): FastifyInstance {
  const ctx: AdminContext = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    // performance.now(), not Date.now(): see AdminDeps.monotonic.
    monotonic: deps.monotonic ?? (() => performance.now()),
    loginAttempts:
      deps.loginAttempts ?? new AttemptCounter(LOGIN_ATTEMPT_LIMIT, LOGIN_ATTEMPT_WINDOW_MS),
    passwordGate: deps.passwordGate ?? new ConcurrencyGate(PASSWORD_CHECKS_IN_FLIGHT),
    checkGate: deps.checkGate ?? new ConcurrencyGate(DNS_CHECKS_IN_FLIGHT),
  }

  const app = Fastify({
    trustProxy: opts.trustProxy,
    logger: deps.log !== false,
    bodyLimit: MAX_BODY_BYTES,
    requestTimeout: 20_000,
    // Nothing here answers a HEAD usefully, and a generated HEAD route on a
    // write would be one more way to reach it.
    exposeHeadRoutes: false,
  })

  app.addHook('onRequest', async (req, reply) => {
    securityHeaders(reply)

    // The internal healthcheck, before the host guard: Compose probes it on
    // 127.0.0.1, which is not the admin host and never will be.
    if (req.url === '/health') return

    if (ctx.adminHost === null) {
      return reply
        .code(503)
        .send({ error: 'not_configured', message: 'set CLICKMONK_ADMIN_HOST and restart' })
    }
    // The admin API answers on its own host name and no other. Caddy routes
    // by name, so this is the second gate rather than the first — and the
    // Compose network is not a boundary: any container in the install can
    // open a connection to this port and send whatever Host it likes.
    if (normaliseHost(req.hostname ?? '') !== ctx.adminHost) {
      return reply.code(404).send({ error: 'not_found', message: 'no such host on this service' })
    }
    checkCsrf({
      method: req.method,
      origin: req.headers.origin,
      hasBearer: hasBearer(req),
      adminHost: ctx.adminHost,
    })
    req.credential = (await authenticate(ctx.pg, req, ctx.now())) ?? undefined
  })

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      for (const [name, value] of Object.entries(err.headers)) reply.header(name, value)
      return reply.code(err.status).send({ error: err.code, message: err.message })
    }
    const fastifyError = err as { statusCode?: number; code?: string }
    if (fastifyError.statusCode === 400 || fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(400).send({ error: 'invalid_body', message: 'the body is not valid JSON' })
    }
    if (fastifyError.statusCode === 413) {
      return reply.code(413).send({ error: 'body_too_large', message: 'the body is too large' })
    }
    // Anything unexpected is logged here and described to the caller as
    // nothing: a stack, a query or a constraint name in the answer tells an
    // attacker about the schema.
    reply.log.error({ err }, 'admin request failed')
    return reply.code(500).send({ error: 'internal', message: 'something went wrong' })
  })

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'no such route' }),
  )

  // Liveness, and deliberately nothing else. It is the one route in front of
  // the host guard, because Compose probes it on 127.0.0.1, which is never the
  // admin host — which also means Caddy serves it to the whole internet on the
  // admin host name. So it touches no table and reveals neither whether the
  // install is configured nor whether an admin account exists; a stranger must
  // not be able to learn that the account is still unclaimed. Readiness is
  // `GET /api/me`, behind the host guard and a credential.
  //
  // It touching no table matters in the other direction too: a query against
  // `admin_account` would fail on a cold install until the worker's boot
  // migration created it, and `up --wait` would then be gated on a migration
  // this service does not run.
  app.get('/health', async () => ({ status: 'ok' }))

  registerSessionRoutes(app, ctx)

  return app
}
