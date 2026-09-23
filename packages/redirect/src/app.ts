import {
  AttemptCounter,
  type ClickRecord,
  ConcurrencyGate,
  type Decision,
  type IpFacts,
  MAX_PATH_LENGTH,
  MAX_REFERRER_LENGTH,
  MAX_UA_LENGTH,
  NO_IP_FACTS,
  ZERO_UUID,
  classifyDevice,
  classifyTraffic,
  evaluate,
  normaliseHost,
  parseBrowser,
  parseOs,
  passwordFingerprint,
  slugFromPath,
  uuidv7,
  verifyPassword,
} from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import { type IpLookup, addressOnly, canonicalIp } from '@clickmonk/ipdata'
import Fastify, { type FastifyInstance } from 'fastify'
import { checkCap, tryConsumeCap } from './cap.js'
import {
  MAX_PASSWORD_BODY_BYTES,
  PASSWORD_ATTEMPT_LIMIT,
  PASSWORD_ATTEMPT_WINDOW_MS,
  PASSWORD_CHECKS_IN_FLIGHT,
  hasPasswordProof,
  passwordFromBody,
  passwordPage,
  passwordProofCookie,
  tooManyAttemptsPage,
} from './password.js'
import type { RateCounter } from './rate.js'
import type { Snapshot } from './snapshot.js'
import type { SpoolWriter } from './spool.js'
import { readVisitor, visitorCookies } from './visitor.js'

export interface RedirectDeps {
  snapshot: () => Snapshot | null
  spool: Pick<SpoolWriter, 'append'>
  capPool: Pool
  secret: string
  /** The loaded IP data, or null while there is none. Omitted: none. */
  ipdata?: () => IpLookup | null
  /** Requests per address, for the abuser class; the one `/health` reports. */
  rate: RateCounter
  now?: () => Date
  random?: () => number
  /** Wrong password answers per address and link. Omitted: this file's bounds. */
  passwordAttempts?: AttemptCounter
  /** Password checks in flight in this process. Omitted: this file's bound. */
  passwordGate?: ConcurrencyGate
  /**
   * The clock the attempt counter is keyed on; omitted, `performance.now()`.
   * Never `now`: that is the wall clock a click is recorded with, and one
   * stepped backwards must not turn an attempt window over and hand a guesser
   * a fresh allowance.
   */
  monotonic?: () => number
  /** `false` silences Fastify's logger (tests); omitted, it logs. */
  log?: false
}

const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0'

const BODIES: Record<number, string> = {
  403: 'This link is not available here.\n',
  404: 'Not found.\n',
  410: 'This link has expired.\n',
}

/**
 * The IP data never throws on a lookup; if a defect ever made it, the
 * click is served and recorded without IP facts rather than lost to a 500.
 */
function lookupIp(ipdata: RedirectDeps['ipdata'], ip: string): IpFacts {
  try {
    return ipdata?.()?.lookup(ip) ?? NO_IP_FACTS
  } catch {
    return NO_IP_FACTS
  }
}

export function buildRedirectApp(
  deps: RedirectDeps,
  opts: { trustProxy: string | string[] | boolean },
): FastifyInstance {
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const app = Fastify({
    trustProxy: opts.trustProxy,
    logger: deps.log !== false,
    // Bounds on what an anonymous caller can make the process hold. The path
    // is bounded by the handler below, which answers 414. The only body this
    // service reads is the password form.
    bodyLimit: MAX_PASSWORD_BODY_BYTES,
    requestTimeout: 10_000,
    // A HEAD route is generated for the GET route below.
    exposeHeadRoutes: true,
  })

  // The password gate's own bounds, per process. Both are in memory: a
  // restart starts a new window, which a per-minute count can afford.
  const passwordAttempts =
    deps.passwordAttempts ?? new AttemptCounter(PASSWORD_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_MS)
  const passwordGate = deps.passwordGate ?? new ConcurrencyGate(PASSWORD_CHECKS_IN_FLIGHT)
  const monotonic = deps.monotonic ?? (() => performance.now())

  // The password form is the one body this service reads. Parsed here rather
  // than by a plugin, and only as a bounded query string: nothing else about
  // a POST is interpreted.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: MAX_PASSWORD_BODY_BYTES },
    (_req, body, done) => {
      const params = new URLSearchParams(typeof body === 'string' ? body : '')
      done(null, { password: params.get('password') ?? '' })
    },
  )

  app.get('*', async (req, reply) => {
    const snapshot = deps.snapshot()
    if (!snapshot) {
      return reply
        .code(503)
        .header('cache-control', NO_STORE)
        .header('retry-after', '5')
        .send('Starting up.\n')
    }

    const rawUrl = req.raw.url ?? '/'
    const q = rawUrl.indexOf('?')
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q)
    if (path.length > MAX_PATH_LENGTH)
      return reply.code(414).header('cache-control', NO_STORE).send('URI too long.\n')
    const host = normaliseHost(req.hostname)
    if (!host) return reply.code(400).header('cache-control', NO_STORE).send('Bad host.\n')
    const query = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1))

    const domain = snapshot.domain(host)
    const slug = slugFromPath(path)
    const link = domain && slug ? snapshot.link(domain.id, slug) : null
    // Everything the click record needs from the request or its socket, read
    // now rather than after the cap-check await below: a client that
    // disconnects while that await is pending leaves `req.ip` (a getter over
    // the socket's remoteAddress) undefined, and req.headers is safest read
    // once too rather than trusted to stay untouched across an await.
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, MAX_UA_LENGTH)
    const referrer = String(req.headers.referer ?? '').slice(0, MAX_REFERRER_LENGTH)
    // A proxy can name the client as `[2001:db8::1]:443` or `192.0.2.1:8080`,
    // or an IPv4 client as `::ffff:192.0.2.1`: the lookup, the rate count and
    // the record all take the address alone, in one form per address.
    const ip = canonicalIp(addressOnly(req.ip ?? '').slice(0, 45))
    const visitor = readVisitor(req.headers.cookie, deps.secret)
    const clickId = uuidv7()
    const at = now()

    // In memory, synchronous and bounded: no lookup waits on the network.
    const ipFacts = lookupIp(deps.ipdata, ip)
    const traffic = classifyTraffic({
      userAgent,
      head: req.method === 'HEAD',
      // A monotonic clock: a wall clock stepped back would restart every count.
      clicksThisMinute: deps.rate.hit(ip, performance.now()),
      abuserThreshold: snapshot.settings.abuserThreshold,
      ip: ipFacts,
    })

    const facts = {
      path,
      query,
      now: at,
      device: classifyDevice(userAgent),
      country: ipFacts.country,
      seenLink: link !== null && visitor.seen.includes(link.id),
      clickId,
      random: random(),
      // Read only for a link that has a password: a link without one costs
      // nothing for the gate existing.
      passwordOk:
        link?.passwordHash == null
          ? true
          : hasPasswordProof({
              cookieHeader: req.headers.cookie,
              linkId: link.id,
              fingerprint: passwordFingerprint(link.passwordHash),
              nowMs: at.getTime(),
              secret: deps.secret,
            }),
    }
    const input = { facts, domain, link, traffic, settings: snapshot.settings }
    let decision: Decision = evaluate({ ...input, capExhausted: false })
    let capUnchecked = false
    // A used-up cap closes the link to every click that would reach a
    // destination. A counted click consumes one; a flagged click or a HEAD
    // request only reads the counter. Each call is bounded and fails open.
    if (decision.reached && link?.clickCap) {
      const cap = decision.counted
        ? await tryConsumeCap(deps.capPool, link.id, link.clickCap)
        : await checkCap(deps.capPool, link.id, link.clickCap)
      if (cap === 'exhausted') decision = evaluate({ ...input, capExhausted: true })
      if (cap === 'unchecked') capUnchecked = true
    }

    const record: ClickRecord = {
      v: 3,
      clickId,
      time: at.toISOString(),
      host,
      path,
      domainId: domain?.id ?? ZERO_UUID,
      linkId: link?.id ?? ZERO_UUID,
      outcome: decision.outcome,
      step: decision.step,
      status: decision.status,
      destination: decision.location,
      targetId: decision.targetId,
      visitorId: visitor.id,
      returning: facts.seenLink,
      device: facts.device,
      country: facts.country,
      userAgent,
      referrer,
      ip,
      capUnchecked,
      trafficClass: traffic.class,
      signals: traffic.signals,
      action: decision.action,
      os: parseOs(userAgent),
      browser: parseBrowser(userAgent),
      asn: ipFacts.asn,
      geoSource: ipFacts.geoSource,
    }
    // Accepted here: the line is written before the response. A refused
    // append (spool full, disk error) is counted by the spool and the
    // visitor is still sent on.
    deps.spool.append(record)

    if (domain?.verified) {
      reply.header(
        'set-cookie',
        visitorCookies(visitor, decision.reached && link ? link.id : null, deps.secret),
      )
    }
    reply.header('cache-control', NO_STORE)
    if (decision.status === 302 && decision.location) {
      return reply.code(302).header('location', decision.location).send()
    }
    // The one body this service sends a visitor that is not an error: the
    // password form, on the link's own URL.
    if (decision.status === 200) {
      return reply.code(200).type('text/html; charset=utf-8').send(passwordPage())
    }
    return reply
      .code(decision.status)
      .type('text/plain; charset=utf-8')
      .send(BODIES[decision.status] ?? '')
  })

  /**
   * The password form, posted back to the link's own URL. Only a link with a
   * password answers here; every other POST is a 404, exactly as it was before
   * the gate existed.
   *
   * A right answer sets the proof cookie and sends the visitor to the same URL
   * as a `302`, so the click is resolved, counted and recorded by the GET path
   * alone — one place decides where a visitor goes.
   */
  app.post('*', async (req, reply) => {
    const snapshot = deps.snapshot()
    if (!snapshot) {
      return reply
        .code(503)
        .header('cache-control', NO_STORE)
        .header('retry-after', '5')
        .send('Starting up.\n')
    }
    const rawUrl = req.raw.url ?? '/'
    const q = rawUrl.indexOf('?')
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q)
    if (path.length > MAX_PATH_LENGTH)
      return reply.code(414).header('cache-control', NO_STORE).send('URI too long.\n')
    const host = normaliseHost(req.hostname)
    if (!host) return reply.code(400).header('cache-control', NO_STORE).send('Bad host.\n')
    const domain = snapshot.domain(host)
    const slug = slugFromPath(path)
    const link = domain?.verified && slug ? snapshot.link(domain.id, slug) : null
    if (!link || !link.enabled || link.passwordHash === null) {
      return reply.code(404).header('cache-control', NO_STORE).send(BODIES[404])
    }

    const at = now()
    const ip = canonicalIp(addressOnly(req.ip ?? '').slice(0, 45))
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, MAX_UA_LENGTH)
    const record = (status: number): void => {
      deps.spool.append({
        v: 3,
        clickId: uuidv7(),
        time: at.toISOString(),
        host,
        path,
        domainId: domain?.id ?? ZERO_UUID,
        linkId: link.id,
        outcome: 'password',
        step: 'password',
        status,
        destination: null,
        targetId: null,
        visitorId: readVisitor(req.headers.cookie, deps.secret).id,
        returning: false,
        device: classifyDevice(userAgent),
        country: lookupIp(deps.ipdata, ip).country,
        userAgent,
        referrer: String(req.headers.referer ?? '').slice(0, MAX_REFERRER_LENGTH),
        ip,
        capUnchecked: false,
        trafficClass: 'unknown',
        signals: [],
        action: null,
        os: parseOs(userAgent),
        browser: parseBrowser(userAgent),
        asn: lookupIp(deps.ipdata, ip).asn,
        geoSource: lookupIp(deps.ipdata, ip).geoSource,
      })
    }

    const key = `${ip}|${link.id}`
    // Monotonic, never `at.getTime()`: `at` is the wall clock the click is
    // recorded with, and a step backwards on it must not clear this counter.
    const tick = monotonic()

    /**
     * A wrong answer: the same page a first visit gets, with the one line that
     * says so, and the attempt counted. Two paths reach it — a password the
     * verifier refused, and a body with no password at all — and they must be
     * indistinguishable from outside.
     */
    const wrong = () => {
      passwordAttempts.fail(key, tick)
      record(200)
      return reply
        .code(200)
        .header('cache-control', NO_STORE)
        .type('text/html; charset=utf-8')
        .send(passwordPage({ wrong: true }))
    }

    const attempt = passwordAttempts.check(key, tick)
    if (!attempt.allowed) {
      record(429)
      return reply
        .code(429)
        .header('cache-control', NO_STORE)
        .header('retry-after', String(Math.ceil(attempt.retryAfterMs / 1000)))
        .type('text/html; charset=utf-8')
        .send(tooManyAttemptsPage())
    }
    const password = passwordFromBody(req.body)
    // A body with no password at all is a wrong answer, counted as one: it is
    // the cheapest way to ask this endpoint for work. It never takes a slot,
    // because nothing is going to be verified.
    if (password === null) return wrong()
    if (!passwordGate.tryEnter()) {
      record(503)
      return reply
        .code(503)
        .header('cache-control', NO_STORE)
        .header('retry-after', '1')
        .type('text/html; charset=utf-8')
        .send(tooManyAttemptsPage())
    }
    let ok = false
    try {
      // Every answer goes through the verifier, including one offered against
      // a stored value that is not a hash: an unreadable value in a snapshot
      // file keeps its link locked because nothing parses it, so a check that
      // read such a value as "no password" would open every damaged link.
      ok = await verifyPassword(password, link.passwordHash)
    } finally {
      passwordGate.leave()
    }
    if (!ok) return wrong()
    passwordAttempts.succeed(key)
    record(302)
    return (
      reply
        .code(302)
        .header('cache-control', NO_STORE)
        .header(
          'set-cookie',
          passwordProofCookie({
            linkId: link.id,
            fingerprint: passwordFingerprint(link.passwordHash),
            nowMs: at.getTime(),
            secret: deps.secret,
          }),
        )
        // The same URL, so the GET path resolves and counts the click.
        .header('location', rawUrl)
        .send()
    )
  })

  // Anything but GET/HEAD on a link domain is simply not there.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).header('cache-control', NO_STORE).send(BODIES[404]),
  )

  return app
}
