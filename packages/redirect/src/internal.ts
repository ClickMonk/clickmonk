import { normaliseHost } from '@clickmonk/core'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Snapshot } from './snapshot.js'
import type { SpoolWriter } from './spool.js'

export function buildInternalApp(deps: {
  snapshot: () => Snapshot | null
  spool: Pick<SpoolWriter, 'stats'>
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
    }
  })

  // Caddy's on-demand TLS asks here before obtaining a certificate.
  // Yes only for a domain the admin added and verified.
  app.get<{ Querystring: { domain?: string } }>('/ask', async (req, reply) => {
    const host = req.query.domain ? normaliseHost(req.query.domain) : null
    if (!host) return reply.code(400).send()
    const d = deps.snapshot()?.domain(host)
    return d?.verified ? reply.code(200).send() : reply.code(404).send()
  })

  return app
}
