import { normaliseHost } from '@clickmonk/core'
import type { SourceStatus } from '@clickmonk/ipdata'
import Fastify, { type FastifyInstance } from 'fastify'
import type { RateCounter } from './rate.js'
import type { Snapshot } from './snapshot.js'
import type { SpoolWriter } from './spool.js'

export function buildInternalApp(deps: {
  snapshot: () => Snapshot | null
  spool: Pick<SpoolWriter, 'stats'>
  /** Each IP data source loaded, with its version and age; empty while there is none. */
  ipdata?: () => SourceStatus[]
  rate?: Pick<RateCounter, 'stats'>
  /**
   * The host name the admin interface answers on, or null when this install
   * has none. It is not a link domain, so it has no verified row of its own,
   * and without it the admin interface could never obtain a certificate.
   */
  adminHost?: string | null
}): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/ready', async (_req, reply) => {
    return deps.snapshot() ? { status: 'ready' } : reply.code(503).send({ status: 'starting' })
  })

  app.get('/health', async () => {
    const s = deps.snapshot()
    return {
      status: s ? 'ok' : 'starting',
      snapshot: s ? { source: s.source, loadedAt: s.loadedAt.toISOString(), ...s.size } : null,
      spool: deps.spool.stats(),
      ipdata: deps.ipdata?.() ?? [],
      rate: deps.rate?.stats() ?? null,
    }
  })

  // Caddy's on-demand TLS asks here before obtaining a certificate. Yes for a
  // domain the admin added and verified, and for the admin host name this
  // install is configured with. Nothing else, ever: a host name pointed at
  // this server by somebody else gets no certificate and no ACME request.
  app.get<{ Querystring: { domain?: string } }>('/ask', async (req, reply) => {
    const host = req.query.domain ? normaliseHost(req.query.domain) : null
    if (!host) return reply.code(400).send()
    if (deps.adminHost && host === deps.adminHost) return reply.code(200).send()
    const d = deps.snapshot()?.domain(host)
    return d?.verified ? reply.code(200).send() : reply.code(404).send()
  })

  return app
}
