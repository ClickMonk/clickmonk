import http from 'node:http'
import {
  type ClickRecord,
  ClickRecordSchema,
  type Domain,
  type Link,
  isDestinationUrl,
} from '@clickmonk/core'
import { type Pool, createPgPool } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRedirectApp } from './app.js'
import { Snapshot } from './snapshot.js'

const SECRET = 'test-secret-that-is-long-enough-000000'
const pool = testPg()
const ch = testCh()

const domain: Domain = {
  id: '00000000-0000-4000-8000-00000000000d',
  host: 'go.example.test',
  verified: true,
  rootUrl: null,
  notFoundUrl: null,
}
const unverifiedDomain: Domain = {
  id: '00000000-0000-4000-8000-00000000000e',
  host: 'pending.example.test',
  verified: false,
  rootUrl: null,
  notFoundUrl: null,
}
const link = (over: Partial<Link> = {}): Link => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  domainId: domain.id,
  slug: 'spring',
  enabled: true,
  targets: [
    {
      id: '00000000-0000-4000-8000-0000000000f1',
      url: 'https://example.com/offer?cid={click_id}',
      weight: 100,
    },
  ],
  backupUrl: 'https://example.com/backup',
  deviceUrls: {},
  returningUrl: 'https://example.com/again',
  countries: { mode: 'all' },
  clickCap: null,
  expiresAt: null,
  passthrough: true,
  ...over,
})

function harness(
  links: Link[],
  opts: { snapshot?: Snapshot | null; capPool?: ReturnType<typeof createPgPool> } = {},
) {
  const records: ClickRecord[] = []
  const snap =
    opts.snapshot === undefined
      ? new Snapshot([domain], links, new Date(), 'postgres')
      : opts.snapshot
  const app = buildRedirectApp(
    {
      snapshot: () => snap,
      spool: {
        append: (r) => {
          records.push(r)
          return true
        },
      },
      capPool: opts.capPool ?? pool,
      secret: SECRET,
      random: () => 0.5,
      log: false,
    },
    { trustProxy: '127.0.0.1' },
  )
  return { app, records }
}

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

describe('redirect', () => {
  it('redirects with 302 and no-store, and records the click it answers', async () => {
    const { app, records } = harness([link()])
    const res = await app.inject({
      method: 'GET',
      url: '/spring?utm_source=nl',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0')
    expect(records).toHaveLength(1)
    const r = records[0] as ClickRecord
    expect(res.headers.location).toBe(`https://example.com/offer?cid=${r.clickId}&utm_source=nl`)
    expect(r).toMatchObject({
      host: 'go.example.test',
      path: '/spring',
      linkId: link().id,
      domainId: domain.id,
      outcome: 'target',
      status: 302,
      targetId: '00000000-0000-4000-8000-0000000000f1',
      returning: false,
      capUnchecked: false,
    })
  })

  it('records a 404 on an unknown host, with zero ids', async () => {
    const { app, records } = harness([link()])
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'nope.example.test' },
    })
    expect(res.statusCode).toBe(404)
    expect(records[0]).toMatchObject({
      outcome: 'unknown_domain',
      linkId: '00000000-0000-0000-0000-000000000000',
    })
  })

  it('sets no cookies for a host it does not serve', async () => {
    const { app } = harness([link()])
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'nope.example.test' },
    })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('sets no cookies for a domain that exists but is not verified', async () => {
    const snap = new Snapshot([unverifiedDomain], [], new Date(), 'postgres')
    const { app } = harness([], { snapshot: snap })
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'pending.example.test' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('matches the host case-insensitively', async () => {
    const { app } = harness([link()])
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'GO.Example.TEST' },
    })
    expect(res.statusCode).toBe(302)
  })

  it('records a destination the worker can store, however long the query', async () => {
    const l = link({
      targets: [
        {
          id: '00000000-0000-4000-8000-0000000000f1',
          url: 'https://example.com/o?s={param:s}',
          weight: 100,
        },
      ],
    })
    const { app, records } = harness([l])
    const res = await app.inject({
      method: 'GET',
      url: `/spring?s=${'x'.repeat(5000)}`,
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(302)
    expect(ClickRecordSchema.safeParse(records[0]).success).toBe(true)
  })

  it('ignores the port in the Host header', async () => {
    const { app } = harness([link()])
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test:8080' },
    })
    expect(res.statusCode).toBe(302)
  })

  it('sends a returning visitor to the returning URL', async () => {
    const { app } = harness([link()])
    const first = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    const cookie = [first.headers['set-cookie'] ?? []]
      .flat()
      .map((c) => c.split(';')[0])
      .join('; ')
    const second = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test', cookie },
    })
    expect(second.headers.location).toBe('https://example.com/again')
  })

  it('does not mark a link seen when the visitor was sent to its backup', async () => {
    const { app } = harness([link({ expiresAt: new Date(Date.now() - 1000) })])
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.headers.location).toBe('https://example.com/backup')
    // One Set-Cookie arrives as a string, several as an array.
    const cookies = [res.headers['set-cookie'] ?? []].flat()
    expect(cookies.some((c) => c.startsWith('cm_seen='))).toBe(false)
  })

  it('stops at the cap and sends the rest to the backup', async () => {
    await pool.query(
      "INSERT INTO domains (id, host, verified) VALUES ($1, 'go.example.test', true) ON CONFLICT DO NOTHING",
      [domain.id],
    )
    const capped = link({ clickCap: 2, returningUrl: null })
    await pool.query(
      "INSERT INTO links (id, domain_id, slug, click_cap) VALUES ($1, $2, 'spring', 2)",
      [capped.id, domain.id],
    )
    const { app, records } = harness([capped])
    const locations: string[] = []
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/spring',
        headers: { host: 'go.example.test' },
      })
      locations.push(res.headers.location as string)
    }
    expect(locations.filter((l) => l === 'https://example.com/backup')).toHaveLength(2)
    expect(records.map((r) => r.outcome)).toEqual(['target', 'target', 'capped', 'capped'])
  })

  it('never touches the cap counter for a click the evaluator already refused', async () => {
    await pool.query(
      "INSERT INTO domains (id, host, verified) VALUES ($1, 'go.example.test', true) ON CONFLICT DO NOTHING",
      [domain.id],
    )
    const stale = link({
      id: '00000000-0000-4000-8000-0000000000a2',
      slug: 'stale',
      clickCap: 5,
      expiresAt: new Date(Date.now() - 1000),
    })
    await pool.query(
      "INSERT INTO links (id, domain_id, slug, click_cap) VALUES ($1, $2, 'stale', 5) ON CONFLICT DO NOTHING",
      [stale.id, domain.id],
    )
    const { app, records } = harness([stale])
    const res = await app.inject({
      method: 'GET',
      url: '/stale',
      headers: { host: 'go.example.test' },
    })
    expect(res.headers.location).toBe('https://example.com/backup')
    expect(records[0]?.outcome).toBe('expired')
    const counters = await pool.query('SELECT 1 FROM link_counters WHERE link_id = $1', [stale.id])
    expect(counters.rowCount).toBe(0)
  })

  it('fails open, and says so, when the cap cannot be checked', async () => {
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 150,
      queryTimeoutMs: 150,
    })
    const { app, records } = harness([link({ clickCap: 1 })], { capPool: dead })
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(302)
    expect(records[0]?.capUnchecked).toBe(true)
    await dead.end()
  })

  it('still records the click when the client disconnects while the cap check is pending', async () => {
    // A cap query slower than tryConsumeCap's own 150 ms bound: the redirect
    // waits out that bound and treats the cap as unchecked, but the record
    // must not depend on the request's socket still being open when it does.
    const slowPool = {
      query: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rowCount: 1, rows: [{ clicks: 1 }] }), 300)
        }),
    } as unknown as Pool
    const { app, records } = harness([link({ clickCap: 5 })], { capPool: slowPool })
    await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no server address')
      await new Promise<void>((resolve) => {
        const client = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/spring',
            headers: { host: 'go.example.test' },
          },
          () => {},
        )
        // The abort itself surfaces as a client-side socket error; not under test.
        client.on('error', () => {})
        client.end()
        setTimeout(() => client.destroy(), 50)
        setTimeout(resolve, 400)
      })
    } finally {
      await app.close()
    }
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('target')
    expect(records[0]?.capUnchecked).toBe(true)
  })

  it('answers 503 and records nothing while there is no configuration', async () => {
    const { app, records } = harness([], { snapshot: null })
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(503)
    expect(records).toHaveLength(0)
  })

  it('answers 414 for an over-long path, and 400 for an over-long host, both no-store', async () => {
    const { app } = harness([link()])
    const long = await app.inject({
      method: 'GET',
      url: `/${'a'.repeat(2100)}`,
      headers: { host: 'go.example.test' },
    })
    expect(long.statusCode).toBe(414)
    expect(long.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0')
    const badHost = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { host: `${'a'.repeat(254)}.test` },
    })
    expect(badHost.statusCode).toBe(400)
    expect(badHost.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0')
  })

  it('sends every destination the validator accepts as its Location, and records the status it sent', async () => {
    // Accepted and rejected candidates together: the invariant is that no
    // accepted one fails on the way out, whatever the validator's rules are.
    const candidates = [
      'https://example.com/plain',
      'https://xn--bcher-kva.example/',
      'https://example.com/%E6%97%A5%E6%9C%AC?q=%C3%BC',
      "https://example.com/a|b~c!d'e(f)*g",
      'https://example.com/a\nb',
      'https://example.com/a\tb',
      'https://example.com/日本',
      'https://example.com/café',
      'https://bücher.example/',
    ]
    const accepted = candidates.filter(isDestinationUrl)
    expect(accepted.length).toBeGreaterThanOrEqual(4)
    for (const url of accepted) {
      const l = link({
        targets: [{ id: '00000000-0000-4000-8000-0000000000f1', url, weight: 100 }],
        returningUrl: null,
        passthrough: false,
      })
      const { app, records } = harness([l])
      const res = await app.inject({
        method: 'GET',
        url: '/spring',
        headers: { host: 'go.example.test' },
      })
      expect(res.statusCode, url).toBe(302)
      expect(res.headers.location, url).toBe(url)
      expect(records.map((r) => r.status)).toEqual([res.statusCode])
    }
  })

  it('truncates the user-agent and referrer it records', async () => {
    const { app, records } = harness([link()])
    await app.inject({
      method: 'GET',
      url: '/spring',
      headers: {
        host: 'go.example.test',
        'user-agent': 'u'.repeat(900),
        referer: `https://example.com/${'r'.repeat(3000)}`,
      },
    })
    expect(records[0]?.userAgent).toHaveLength(512)
    expect(records[0]?.referrer).toHaveLength(2048)
  })

  it('believes X-Forwarded-For only from a trusted proxy', async () => {
    const { app, records } = harness([link()])
    await app.inject({
      method: 'GET',
      url: '/spring',
      remoteAddress: '127.0.0.1',
      headers: { host: 'go.example.test', 'x-forwarded-for': '198.51.100.7' },
    })
    await app.inject({
      method: 'GET',
      url: '/spring',
      remoteAddress: '203.0.113.9',
      headers: { host: 'go.example.test', 'x-forwarded-for': '198.51.100.7' },
    })
    expect(records.map((r) => r.ip)).toEqual(['198.51.100.7', '203.0.113.9'])
  })

  it('answers HEAD like GET, and records it', async () => {
    const { app, records } = harness([link()])
    const res = await app.inject({
      method: 'HEAD',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(302)
    expect(records).toHaveLength(1)
  })

  it('refuses other methods without recording', async () => {
    const { app, records } = harness([link()])
    const res = await app.inject({
      method: 'POST',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(404)
    expect(records).toHaveLength(0)
  })

  it('still redirects when the spool refuses the record', async () => {
    const snap = new Snapshot([domain], [link()], new Date(), 'postgres')
    const app = buildRedirectApp(
      {
        snapshot: () => snap,
        spool: { append: () => false },
        capPool: pool,
        secret: SECRET,
        log: false,
      },
      { trustProxy: false },
    )
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: { host: 'go.example.test' },
    })
    expect(res.statusCode).toBe(302)
  })
})
