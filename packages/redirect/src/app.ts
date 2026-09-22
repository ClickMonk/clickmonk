import {
  type ClickRecord,
  type Decision,
  MAX_UA_LENGTH,
  ZERO_UUID,
  classifyDevice,
  evaluate,
  normaliseHost,
  slugFromPath,
  uuidv7,
} from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { tryConsumeCap } from './cap.js'
import type { Snapshot } from './snapshot.js'
import type { SpoolWriter } from './spool.js'
import { readVisitor, visitorCookies } from './visitor.js'

export interface RedirectDeps {
  snapshot: () => Snapshot | null
  spool: Pick<SpoolWriter, 'append'>
  capPool: Pool
  secret: string
  now?: () => Date
  random?: () => number
  /** `false` silences Fastify's logger (tests); omitted, it logs. */
  log?: false
}

const MAX_PATH = 2048
const MAX_REFERRER = 2048
const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0'

const BODIES: Record<number, string> = {
  403: 'This link is not available here.\n',
  404: 'Not found.\n',
  410: 'This link has expired.\n',
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
    // is bounded by the handler below, which answers 414.
    bodyLimit: 1024,
    requestTimeout: 10_000,
    // A HEAD route is generated for the GET route below.
    exposeHeadRoutes: true,
  })

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
    if (path.length > MAX_PATH)
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
    const referrer = String(req.headers.referer ?? '').slice(0, MAX_REFERRER)
    const ip = (req.ip ?? '').slice(0, 45)
    const visitor = readVisitor(req.headers.cookie, deps.secret)
    const clickId = uuidv7()
    const at = now()

    const facts = {
      path,
      query,
      now: at,
      device: classifyDevice(userAgent),
      country: null, // No IP-to-country lookup yet.
      seenLink: link !== null && visitor.seen.includes(link.id),
      clickId,
      random: random(),
    }
    let decision: Decision = evaluate({ facts, domain, link, capExhausted: false })
    let capUnchecked = false
    if (decision.counted && link?.clickCap) {
      const cap = await tryConsumeCap(deps.capPool, link.id, link.clickCap)
      if (cap === 'exhausted') decision = evaluate({ facts, domain, link, capExhausted: true })
      if (cap === 'unchecked') capUnchecked = true
    }

    const record: ClickRecord = {
      v: 1,
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
    }
    // Accepted here: the line is written before the response. A refused
    // append (spool full, disk error) is counted by the spool and the
    // visitor is still sent on.
    deps.spool.append(record)

    if (domain?.verified) {
      reply.header(
        'set-cookie',
        visitorCookies(visitor, decision.counted && link ? link.id : null, deps.secret),
      )
    }
    reply.header('cache-control', NO_STORE)
    if (decision.status === 302 && decision.location) {
      return reply.code(302).header('location', decision.location).send()
    }
    return reply
      .code(decision.status)
      .type('text/plain; charset=utf-8')
      .send(BODIES[decision.status] ?? '')
  })

  // Anything but GET/HEAD on a link domain is simply not there.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).header('cache-control', NO_STORE).send(BODIES[404]),
  )

  return app
}
