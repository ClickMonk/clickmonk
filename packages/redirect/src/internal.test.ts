import type { Domain } from '@clickmonk/core'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
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

  it('reports the IP data loaded and the rate counter', async () => {
    const source = {
      id: 'country' as const,
      version: '2026-01',
      fetchedAt: new Date().toISOString(),
      entries: { k32: 2, k128: 1 },
    }
    const app = buildInternalApp({
      snapshot: () => snap,
      spool,
      ipdata: () => [source],
      rate: { stats: () => ({ addresses: 3, untracked: 0 }) },
    })
    expect((await app.inject('/health')).json()).toMatchObject({
      ipdata: [source],
      rate: { addresses: 3, untracked: 0 },
    })
  })

  it('reports no IP data as an empty list, and no rate counter as null', async () => {
    const none = buildInternalApp({ snapshot: () => snap, spool, ipdata: () => [] })
    expect((await none.inject('/health')).json().ipdata).toEqual([])
    // Without the dependencies at all, as a caller that predates them builds it.
    const omitted = buildInternalApp({ snapshot: () => snap, spool })
    expect((await omitted.inject('/health')).json()).toMatchObject({ ipdata: [], rate: null })
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

describe('the ask check and the admin host', () => {
  const snapshot = new Snapshot(
    [
      {
        id: '00000000-0000-4000-8000-00000000000d',
        host: 'go.example.test',
        verified: true,
        rootUrl: null,
        notFoundUrl: null,
      },
    ],
    [],
    new Date(),
    'postgres',
  )

  const app = (adminHost: string | null) =>
    buildInternalApp({
      snapshot: () => snapshot,
      spool: { stats: () => ({}) as never },
      adminHost,
    })

  it('approves the configured admin host, which has no verified row of its own', async () => {
    const a = app('admin.example.test')
    try {
      expect(
        (await a.inject({ method: 'GET', url: '/ask?domain=admin.example.test' })).statusCode,
      ).toBe(200)
      expect(
        (await a.inject({ method: 'GET', url: '/ask?domain=go.example.test' })).statusCode,
      ).toBe(200)
      // Normalised first, so the same name in another case or with a trailing
      // dot — both of which a client can send — is the same name.
      expect(
        (await a.inject({ method: 'GET', url: '/ask?domain=ADMIN.example.test.' })).statusCode,
      ).toBe(200)
    } finally {
      await a.close()
    }
  })

  // Caddy sends one `domain`; anything else reaching this port is not Caddy.
  // A repeated parameter is an array, and it answers 400 with the other
  // malformed shapes rather than throwing its way to a 500 — this is
  // unauthenticated, and it is the port that decides certificate issuance.
  it.each([
    ['a name repeated', 'go.example.test&domain=go.example.test'],
    ['a verified name beside another', 'go.example.test&domain=other.example.test'],
    ['the admin host repeated', 'admin.example.test&domain=admin.example.test'],
  ])('refuses %s with 400', async (_label, query) => {
    const a = app('admin.example.test')
    try {
      const r = await a.inject({ method: 'GET', url: `/ask?domain=${query}` })
      expect(r.statusCode).toBe(400)
    } finally {
      await a.close()
    }
  })

  // The admin host is one name an operator put in the configuration, not a
  // suffix, a wildcard or anything a request can choose.
  it('approves nothing else, with or without an admin host', async () => {
    const withHost = app('admin.example.test')
    const without = app(null)
    try {
      for (const host of [
        'other.example.test',
        'admin.example.test.evil.example.com',
        'x.admin.example.test',
      ]) {
        const r = await withHost.inject({ method: 'GET', url: `/ask?domain=${host}` })
        expect(r.statusCode, host).toBe(404)
      }
      expect(
        (await without.inject({ method: 'GET', url: '/ask?domain=admin.example.test' })).statusCode,
      ).toBe(404)
    } finally {
      await withHost.close()
      await without.close()
    }
  })
})

// The other half of the pair in config.test.ts: a value this service could not
// parse leaves it in the state an install that never configured an admin host
// runs in, rather than stopping it. What it costs is the admin interface's
// certificate, which is what the logged line says; what it does not cost is a
// single link.
describe('an admin host this service could not read', () => {
  const env = {
    CLICKMONK_POSTGRES_URL: 'postgres://u:p@db:5432/clickmonk',
    CLICKMONK_SECRET: 's'.repeat(32),
    // The likeliest way to get here: a host name typed with capitals.
    CLICKMONK_ADMIN_HOST: 'Admin.Example.Test',
  }

  it('approves a verified link domain and nothing else, as an unconfigured install does', async () => {
    const config = loadConfig(env)
    const app = buildInternalApp({
      snapshot: () => snap,
      spool,
      adminHost: config.adminHost,
    })
    try {
      // The link domain is served and may have a certificate, which is the part
      // that must survive a mistyped variable.
      expect((await app.inject('/ask?domain=go.example.test')).statusCode).toBe(200)
      expect((await app.inject('/ready')).statusCode).toBe(200)
      // Neither the value as written nor the name it was meant to be is
      // approved: this install has no admin host as far as this check goes.
      for (const host of ['Admin.Example.Test', 'admin.example.test']) {
        expect((await app.inject(`/ask?domain=${host}`)).statusCode, host).toBe(404)
      }
    } finally {
      await app.close()
    }
  })
})
