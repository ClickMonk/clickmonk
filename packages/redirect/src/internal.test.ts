import type { Domain } from '@clickmonk/core'
import { describe, expect, it } from 'vitest'
import { buildInternalApp } from './internal.js'
import { Snapshot } from './snapshot.js'

const d = (host: string, verified: boolean): Domain => ({
  id: `00000000-0000-4000-8000-${verified ? '00000000000a' : '00000000000b'}`,
  host,
  verified,
  rootUrl: null,
  notFoundUrl: null,
})

const snap = new Snapshot(
  [d('go.example.test', true), d('pending.example.test', false)],
  [],
  new Date(),
  'postgres',
)
const spool = { stats: () => ({ dropped: 0, pendingBytes: 10 }) }

describe('internal port', () => {
  it('answers ask with 200 for a verified domain only', async () => {
    const app = buildInternalApp({ snapshot: () => snap, spool })
    expect((await app.inject('/ask?domain=go.example.test')).statusCode).toBe(200)
    expect((await app.inject('/ask?domain=GO.EXAMPLE.TEST')).statusCode).toBe(200)
    expect((await app.inject('/ask?domain=pending.example.test')).statusCode).toBe(404)
    expect((await app.inject('/ask?domain=other.example.test')).statusCode).toBe(404)
    expect((await app.inject('/ask')).statusCode).toBe(400)
  })

  it('is not ready and refuses every ask without a snapshot', async () => {
    const app = buildInternalApp({ snapshot: () => null, spool })
    expect((await app.inject('/ready')).statusCode).toBe(503)
    expect((await app.inject('/ask?domain=go.example.test')).statusCode).toBe(404)
  })

  it('reports health with the snapshot source and the spool', async () => {
    const app = buildInternalApp({ snapshot: () => snap, spool })
    const res = await app.inject('/health')
    expect(res.json()).toMatchObject({
      status: 'ok',
      snapshot: { source: 'postgres', links: 0 },
      spool: { dropped: 0, pendingBytes: 10 },
    })
  })
})
