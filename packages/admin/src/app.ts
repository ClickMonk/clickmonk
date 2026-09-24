import { AttemptCounter, ConcurrencyGate, newSlug, normaliseHost } from '@clickmonk/core'
import type { ClickHouseClient, Pool } from '@clickmonk/db'
import { MAX_IP_LENGTH, addressOnly, canonicalIp } from '@clickmonk/ipdata'
import type { DomainResolver } from '@clickmonk/worker/domains'
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { type Credential, authenticate, checkCsrf, hasBearer } from './auth.js'
import {
  EXPORT_BODY_DEADLINE_MS,
  EXPORT_ROW_CAP,
  checkExportRowCap,
  registerClickRoutes,
} from './clicks.js'
import { registerDomainRoutes } from './domains.js'
import { HttpError, MAX_BODY_BYTES, securityHeaders } from './http.js'
import { registerKeyRoutes } from './keys.js'
import { registerLinkRoutes } from './links.js'
import { registerReportRoutes } from './reports.js'
import { registerSessionRoutes } from './session-routes.js'
import { registerSettingsRoutes } from './settings-routes.js'

/** Failed sign-ins from one client before it is refused, and the window. */
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
/**
 * Report queries this process runs at once, and exports.
 *
 * A credential is not a bound: an authenticated caller — or a leaked API key —
 * can loop a report endpoint, and each pass is a scan of a window they chose.
 * Past these the answer is a refusal with `retry-after`, never a queued query,
 * for the same reason the on-demand DNS check refuses rather than queues.
 *
 * The export gate is separate from the report gate, and smaller, because an
 * export holds a ClickHouse result open while its client reads it — for as long
 * as `EXPORT_BODY_DEADLINE_MS`, which is the bound this process sets on it, and
 * far longer than a report's own query bound. Separate so that a download an
 * operator started does not lock their own dashboard out.
 */
export const REPORT_QUERIES_IN_FLIGHT = 2
export const EXPORTS_IN_FLIGHT = 1

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
  /**
   * Where the reports read from. Optional here and required in `loadConfig`:
   * required in configuration so an install with a typo fails at boot with the
   * variable named rather than answering 503 for ever, and optional here so
   * that the 503 path is reachable from a test, and so that a suite about
   * links does not have to build a ClickHouse client to test a link.
   */
  ch?: ClickHouseClient
  reportGate?: ConcurrencyGate
  exportGate?: ConcurrencyGate
  /**
   * Rows one export writes at most. Injectable so that a test can reach the cap
   * with three rows instead of a million; nothing in the product sets it today,
   * and whatever does will be configuration an operator wrote, which is why it
   * is refused at boot rather than trusted — see `checkExportRowCap`.
   */
  exportRowCap?: number
  /**
   * How long one export may hold the export slot while writing its body.
   * Injectable so a test can reach the deadline in milliseconds instead of ten
   * minutes — `EXPORT_BODY_DEADLINE_MS` says what it is for and what it costs.
   */
  exportDeadlineMs?: number
  /**
   * Where a link with no slug of its own gets one. `newSlug` unless a caller
   * says otherwise, and nothing in the product says otherwise: it is here so
   * that a test can hand out a slug that is already taken, which is the only
   * way to reach what this service answers when it runs out of attempts.
   */
  slugSource?: () => string
  /**
   * Fastify's logger option. `false` silences it, which is what every test
   * that does not care what was logged passes; omitted, it logs. A test that
   * has to read the log passes a destination stream here instead.
   */
  log?: FastifyServerOptions['logger']
}

export interface AdminContext extends AdminDeps {
  now: () => Date
  monotonic: () => number
  loginAttempts: AttemptCounter
  passwordGate: ConcurrencyGate
  /** How many on-demand DNS checks this process runs at once. */
  checkGate: ConcurrencyGate
  reportGate: ConcurrencyGate
  exportGate: ConcurrencyGate
  exportRowCap: number
  exportDeadlineMs: number
  slugSource: () => string
}

declare module 'fastify' {
  interface FastifyRequest {
    credential?: Credential
  }
}

/**
 * The address a request came from: the caller's, through Caddy, in one text
 * form per address.
 *
 * **This is an address, not a counter's key**, and it has two readers that want
 * different things. It is written to the session row and handed back by
 * `GET /api/sessions`, where the admin reads it to recognise their own devices,
 * so it must be the address the request carried — a /64 there would show
 * something no request ever came from. The sign-in limiter wants the /64, and
 * takes it with `rateKey` at its own call site. One function returning the
 * narrower value served the limiter and quietly changed what the session list
 * showed.
 *
 * `addressOnly` because a forwarded address may arrive with a port or in
 * brackets, and `canonicalIp` so that one client is one string — the same
 * normalisation the redirect does before it records a click, so the two
 * services name the same client the same way. A string that is not an address
 * is returned unchanged.
 */
export function clientAddress(req: FastifyRequest): string {
  return canonicalIp(addressOnly(req.ip ?? '').slice(0, MAX_IP_LENGTH))
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
    reportGate: deps.reportGate ?? new ConcurrencyGate(REPORT_QUERIES_IN_FLIGHT),
    exportGate: deps.exportGate ?? new ConcurrencyGate(EXPORTS_IN_FLIGHT),
    // Checked here rather than where it is interpolated: a bad one is a fault in
    // how this service was built, so it belongs at boot with the name of the
    // thing that is wrong, not in the 503 every export would answer with.
    exportRowCap: checkExportRowCap(deps.exportRowCap ?? EXPORT_ROW_CAP),
    exportDeadlineMs: deps.exportDeadlineMs ?? EXPORT_BODY_DEADLINE_MS,
    slugSource: deps.slugSource ?? newSlug,
  }

  const app = Fastify({
    trustProxy: opts.trustProxy,
    logger: deps.log ?? true,
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
    //
    // `req.headers.host`, never `req.hostname`: with a trusted proxy
    // configured — and the stack configures one — Fastify takes `req.hostname`
    // from `X-Forwarded-Host` when the peer is trusted, and every container on
    // the bridge network is a trusted peer. That would let any of them claim
    // this host name over a connection that was never sent to it, which is the
    // one thing this gate exists to stop. `Host` is what the connection
    // actually carried.
    //
    // `X-Forwarded-For` stays trusted from those same peers, and that is not
    // the same bargain: Caddy replaces that header rather than appending to
    // it, so a value reaching here came from Caddy, and the only way to forge
    // one is to already be a container inside the install. The limiter below
    // still counts by the address `req.ip` gives, per /64 for IPv6.
    //
    // The port is stripped here rather than by Fastify, which is the one thing
    // `req.hostname` did for free: a browser sends `Host: name:443` and that is
    // the same name. Nothing legitimate ends in a colon and digits, and an
    // IPv6 literal — `[::1]:9100`, which is not a host name either way — is
    // left as something the parse below refuses.
    //
    // `normaliseHost` returns null for a name it cannot parse, which is never
    // equal to a configured host, so a malformed Host is refused by the same
    // line. A request with no Host header at all cannot be made through
    // `inject`, which substitutes one: that case belongs to the suite that
    // drives a real socket.
    const claimed = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (normaliseHost(claimed) !== ctx.adminHost) {
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
  //
  // `logLevel: 'silent'` because Compose probes this every five seconds for
  // the life of the install, and two lines a probe is the whole log. Only this
  // route is silenced; everything else still logs.
  app.get('/health', { logLevel: 'silent' }, async () => ({ status: 'ok' }))

  registerSessionRoutes(app, ctx)
  registerKeyRoutes(app, ctx)
  registerDomainRoutes(app, ctx)
  registerLinkRoutes(app, ctx)
  registerSettingsRoutes(app, ctx)
  registerReportRoutes(app, ctx)
  registerClickRoutes(app, ctx)

  return app
}
