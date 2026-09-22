import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClickRecord,
  ClickRecordSchema,
  DEFAULT_TRAFFIC_SETTINGS,
  type Domain,
  type IpFacts,
  type Link,
  type TrafficSettings,
  isDestinationUrl,
} from '@clickmonk/core'
import { type Pool, createPgPool } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import {
  IpData,
  IpDataStore,
  type IpLookup,
  type RangeTable,
  SOURCES,
  commitTables,
  parseBadAsnList,
  parseDbIpAsn,
  parseDbIpCountry,
  parseOnionoo,
} from '@clickmonk/ipdata'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildRedirectApp } from './app.js'
import { RateCounter } from './rate.js'
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
  trafficActions: {},
  ...over,
})

// Every record any test captures, checked after each test against the schema
// the worker parses spool lines with: a record the redirect writes but the
// worker would skip is a click lost.
const captured: ClickRecord[] = []
afterEach(() => {
  for (const r of captured.splice(0)) {
    const parsed = ClickRecordSchema.safeParse(r)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  }
})

/** A browser: without a user-agent, a request is a bot and flagged, and a flagged click never consumes a cap. */
const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

function harness(
  links: Link[],
  opts: {
    snapshot?: Snapshot | null
    capPool?: ReturnType<typeof createPgPool>
    settings?: TrafficSettings
    /** The IP data, or a getter for it, as the running redirect passes its store's. */
    ipdata?: IpLookup | null | (() => IpLookup | null)
    rate?: RateCounter
    now?: () => Date
  } = {},
) {
  const records: ClickRecord[] = []
  const snap =
    opts.snapshot === undefined
      ? new Snapshot([domain], links, new Date(), 'postgres', opts.settings)
      : opts.snapshot
  const app = buildRedirectApp(
    {
      snapshot: () => snap,
      spool: {
        append: (r) => {
          records.push(r)
          captured.push(r)
          return true
        },
      },
      capPool: opts.capPool ?? pool,
      secret: SECRET,
      random: () => 0.5,
      log: false,
      ipdata: () => (typeof opts.ipdata === 'function' ? opts.ipdata() : opts.ipdata) ?? null,
      rate: opts.rate ?? new RateCounter(),
      ...(opts.now ? { now: opts.now } : {}),
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
        headers: { host: 'go.example.test', 'user-agent': BROWSER },
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
      headers: { host: 'go.example.test', 'user-agent': BROWSER },
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
      headers: { host: 'go.example.test', 'user-agent': BROWSER },
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
            headers: { host: 'go.example.test', 'user-agent': BROWSER },
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
    // Read before the await: after the disconnect the socket has no address.
    expect(records[0]?.ip).toBe('127.0.0.1')
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

  it('serves and records a path of exactly the bound, and answers 414 one past it', async () => {
    const { app, records } = harness([link()])
    const at = await app.inject({
      method: 'GET',
      url: `/${'a'.repeat(2047)}`,
      headers: { host: 'go.example.test' },
    })
    // No slug is that long, so it is not found, but it is served and recorded.
    expect(at.statusCode).toBe(404)
    expect(records[0]?.path).toHaveLength(2048)
    const over = await app.inject({
      method: 'GET',
      url: `/${'a'.repeat(2048)}`,
      headers: { host: 'go.example.test' },
    })
    expect(over.statusCode).toBe(414)
    expect(records).toHaveLength(1)
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
        rate: new RateCounter(),
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

// Made-up IP data on the documentation ranges and ASNs: 192.0.2.0/24 is a
// home network in DE, 198.51.100.0/24 a hosting network in FR with one Tor
// exit, 203.0.113.0/24 is in no table.
const IPDATA = new IpData(
  {
    country: parseDbIpCountry(
      '192.0.2.0,192.0.2.255,DE\n198.51.100.0,198.51.100.255,FR\n',
      SOURCES.country.limits,
    ),
    asn: parseDbIpAsn(
      '192.0.2.0,192.0.2.255,64500,"Example Home"\n198.51.100.0,198.51.100.255,64501,"Example Hosting"\n',
      SOURCES.asn.limits,
    ),
    datacenter: parseBadAsnList('ASN,Entity\n64501,Example Hosting\n', SOURCES.datacenter.limits),
    tor: parseOnionoo('{"relays":[{"exit_addresses":["198.51.100.9"]}]}', SOURCES.tor.limits),
  },
  { country: '2026-01', asn: '2026-01' },
)

describe('traffic classification', () => {
  // Every request below reaches the app from a trusted proxy, which names the visitor.
  const from = (ip: string, over: Record<string, string> = {}) => ({
    host: 'go.example.test',
    'user-agent': BROWSER,
    'x-forwarded-for': ip,
    ...over,
  })
  // The cap counter is a real row, and its link must exist for one to be
  // written: without this, a test that no row appears would pass even if
  // the redirect did try to consume the cap.
  const persist = async (l: Link) => {
    await pool.query(
      "INSERT INTO domains (id, host, verified) VALUES ($1, 'go.example.test', true) ON CONFLICT DO NOTHING",
      [domain.id],
    )
    await pool.query('INSERT INTO links (id, domain_id, slug, click_cap) VALUES ($1, $2, $3, $4)', [
      l.id,
      domain.id,
      l.slug,
      l.clickCap,
    ])
  }
  const settings = (
    actions: Partial<TrafficSettings['actions']>,
    safeUrl: string | null = null,
  ) => ({
    ...DEFAULT_TRAFFIC_SETTINGS,
    actions: { ...DEFAULT_TRAFFIC_SETTINGS.actions, ...actions },
    safeUrl,
  })

  it('records the class, signals, action, OS, browser, ASN and geo source, as version 2', async () => {
    const { app, records } = harness([link()], { ipdata: IPDATA })
    await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    expect(records[0]).toMatchObject({
      v: 2,
      country: 'DE',
      trafficClass: 'human',
      signals: [],
      action: null,
      os: 'windows',
      browser: 'chrome',
      asn: 64500,
      geoSource: 'dbip-country-lite/2026-01',
    })
  })

  it('feeds the looked-up country to the country rule', async () => {
    const l = link({ countries: { mode: 'allow', list: ['DE'] } })
    const { app, records } = harness([l], { ipdata: IPDATA })
    await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    await app.inject({ method: 'GET', url: '/spring', headers: from('198.51.100.7') })
    await app.inject({ method: 'GET', url: '/spring', headers: from('203.0.113.7') })
    expect(records.map((r) => [r.country, r.outcome])).toEqual([
      ['DE', 'target'],
      ['FR', 'country_blocked'],
      [null, 'country_blocked'],
    ])
  })

  it('serves without IP data: no country, IP checks not run, class unknown', async () => {
    const { app, records } = harness([link()])
    const res = await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    expect(res.statusCode).toBe(302)
    expect(records[0]).toMatchObject({
      country: null,
      asn: null,
      geoSource: '',
      trafficClass: 'unknown',
      action: null,
    })
  })

  it('blocks a class set to block with a 403, before it touches the cap', async () => {
    const capped = link({
      id: '00000000-0000-4000-8000-0000000000b1',
      slug: 'blocked',
      clickCap: 5,
    })
    await persist(capped)
    const { app, records } = harness([capped], {
      ipdata: IPDATA,
      settings: settings({ datacenter: 'block' }),
    })
    const res = await app.inject({ method: 'GET', url: '/blocked', headers: from('198.51.100.7') })
    expect(res.statusCode).toBe(403)
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0')
    expect(records[0]).toMatchObject({
      outcome: 'blocked',
      step: 'classify',
      trafficClass: 'datacenter',
      signals: ['datacenter'],
      action: 'block',
    })
    const counters = await pool.query('SELECT 1 FROM link_counters WHERE link_id = $1', [capped.id])
    expect(counters.rowCount).toBe(0)
  })

  it('blocks a class set to block even for a visitor who has clicked the link before', async () => {
    const { app } = harness([link()], { ipdata: IPDATA })
    const first = await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    const cookie = [first.headers['set-cookie'] ?? []]
      .flat()
      .map((c) => c.split(';')[0])
      .join('; ')
    expect(cookie).toContain('cm_seen=')
    const blocking = harness([link()], {
      ipdata: IPDATA,
      settings: settings({ datacenter: 'block' }),
    })
    const res = await blocking.app.inject({
      method: 'GET',
      url: '/spring',
      headers: from('198.51.100.7', { cookie }),
    })
    expect(res.statusCode).toBe(403)
    expect(blocking.records[0]).toMatchObject({ outcome: 'blocked', returning: true })
    // A blocked click marks nothing seen.
    expect([res.headers['set-cookie'] ?? []].flat().some((c) => c.startsWith('cm_seen='))).toBe(
      false,
    )
  })

  it('sends a class set to safe to the safe URL, and a link override wins', async () => {
    const s = settings({ anonymous: 'safe' }, 'https://example.com/safe')
    const { app, records } = harness(
      [
        link(),
        link({
          id: '00000000-0000-4000-8000-0000000000a3',
          slug: 'open',
          trafficActions: { anonymous: 'nothing' },
        }),
      ],
      { ipdata: IPDATA, settings: s },
    )
    const safe = await app.inject({ method: 'GET', url: '/spring', headers: from('198.51.100.9') })
    expect(safe.headers.location).toBe('https://example.com/safe')
    const open = await app.inject({ method: 'GET', url: '/open', headers: from('198.51.100.9') })
    expect(open.headers.location).toMatch(/^https:\/\/example\.com\/offer/)
    expect(records.map((r) => [r.trafficClass, r.outcome, r.action])).toEqual([
      ['anonymous', 'safe', 'safe'],
      ['anonymous', 'target', 'nothing'],
    ])
  })

  it('sends a flagged click on and marks it seen, but never consumes the cap', async () => {
    const capped = link({
      id: '00000000-0000-4000-8000-0000000000b2',
      slug: 'flagged',
      clickCap: 5,
    })
    await persist(capped)
    const { app, records } = harness([capped], { ipdata: IPDATA })
    const res = await app.inject({
      method: 'GET',
      url: '/flagged',
      headers: from('198.51.100.7', { 'user-agent': 'curl/8.5.0' }),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^https:\/\/example\.com\/offer/)
    expect(records[0]).toMatchObject({
      outcome: 'target',
      trafficClass: 'bot',
      signals: ['ua_bot', 'datacenter'],
      action: 'flag',
    })
    expect([res.headers['set-cookie'] ?? []].flat().some((c) => c.startsWith('cm_seen='))).toBe(
      true,
    )
    const counters = await pool.query('SELECT 1 FROM link_counters WHERE link_id = $1', [capped.id])
    expect(counters.rowCount).toBe(0)
  })

  it('answers HEAD with the same redirect, records it as bot, and never consumes the cap', async () => {
    const capped = link({
      id: '00000000-0000-4000-8000-0000000000b3',
      slug: 'probed',
      clickCap: 5,
      returningUrl: null,
    })
    await persist(capped)
    const { app, records } = harness([capped], {
      ipdata: IPDATA,
      settings: settings({ bot: 'block' }),
    })
    const get = await app.inject({ method: 'GET', url: '/probed', headers: from('192.0.2.7') })
    const head = await app.inject({ method: 'HEAD', url: '/probed', headers: from('192.0.2.7') })
    expect(head.statusCode).toBe(302)
    expect(head.headers.location?.replace(/cid=[^&]+/, '')).toBe(
      get.headers.location?.replace(/cid=[^&]+/, ''),
    )
    expect(records[1]).toMatchObject({
      trafficClass: 'bot',
      signals: ['head'],
      action: 'nothing',
      outcome: 'target',
    })
    const counters = await pool.query<{ clicks: string }>(
      'SELECT clicks FROM link_counters WHERE link_id = $1',
      [capped.id],
    )
    // The GET consumed one; the HEAD none.
    expect(counters.rows[0]?.clicks).toBe('1')
  })

  it('answers HEAD as the GET would be answered when the GET is blocked', async () => {
    const { app } = harness([link()], {
      ipdata: IPDATA,
      settings: settings({ datacenter: 'block' }),
    })
    const head = await app.inject({ method: 'HEAD', url: '/spring', headers: from('198.51.100.7') })
    expect(head.statusCode).toBe(403)
  })

  it('closes an exhausted cap to a flagged click and a HEAD request too, without writing the counter', async () => {
    const full = link({ id: '00000000-0000-4000-8000-0000000000b4', slug: 'full', clickCap: 1 })
    const bare = link({
      id: '00000000-0000-4000-8000-0000000000b5',
      slug: 'bare',
      clickCap: 1,
      backupUrl: null,
    })
    for (const l of [full, bare]) {
      await persist(l)
      await pool.query('INSERT INTO link_counters (link_id, clicks) VALUES ($1, 1)', [l.id])
    }
    const { app, records } = harness([full, bare], { ipdata: IPDATA })
    const bot = from('192.0.2.7', { 'user-agent': 'curl/8.5.0' })
    const flagged = await app.inject({ method: 'GET', url: '/full', headers: bot })
    const head = await app.inject({ method: 'HEAD', url: '/full', headers: from('192.0.2.7') })
    const gone = await app.inject({ method: 'GET', url: '/bare', headers: bot })
    expect([flagged.headers.location, head.headers.location]).toEqual([
      'https://example.com/backup',
      'https://example.com/backup',
    ])
    expect(gone.statusCode).toBe(410)
    expect(records.map((r) => [r.trafficClass, r.outcome, r.action])).toEqual([
      ['bot', 'capped', 'flag'],
      ['bot', 'capped', 'nothing'],
      ['bot', 'capped', 'flag'],
    ])
    // Read, never consumed: the counters are where the test left them.
    const c = await pool.query<{ clicks: string }>(
      'SELECT clicks FROM link_counters WHERE link_id = ANY($1) ORDER BY link_id',
      [[full.id, bare.id]],
    )
    expect(c.rows.map((r) => r.clicks)).toEqual(['1', '1'])
  })

  it('fails open, and says so, when the cap cannot be read for a flagged click', async () => {
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 150,
      queryTimeoutMs: 150,
    })
    const { app, records } = harness([link({ clickCap: 1 })], { ipdata: IPDATA, capPool: dead })
    const res = await app.inject({
      method: 'GET',
      url: '/spring',
      headers: from('192.0.2.7', { 'user-agent': 'curl/8.5.0' }),
    })
    expect(res.headers.location).toMatch(/^https:\/\/example\.com\/offer/)
    expect(records[0]).toMatchObject({ outcome: 'target', action: 'flag', capUnchecked: true })
    await dead.end()
  })

  it('classifies an address over the install threshold as an abuser', async () => {
    const { app, records } = harness([link()], {
      ipdata: IPDATA,
      settings: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 2 },
      rate: new RateCounter(),
    })
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    }
    await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.8') })
    expect(records.map((r) => r.trafficClass)).toEqual(['human', 'human', 'abuser', 'human'])
    expect(records[2]?.signals).toEqual(['rate'])
  })

  it('never lets a lookup fail the request', async () => {
    const broken: IpLookup = {
      lookup: (): IpFacts => {
        throw new Error('lookup failed')
      },
    }
    const { app } = harness([link()], { ipdata: broken })
    const res = await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    expect(res.statusCode).toBe(302)
  })

  it('classifies and records the same user-agent, cut to its bound', async () => {
    const { app, records } = harness([link()], { ipdata: IPDATA })
    // A crawler's name past the bound is neither recorded nor classified.
    const long = `${BROWSER}${' '.repeat(600)} Googlebot/2.1`
    await app.inject({
      method: 'GET',
      url: '/spring',
      headers: from('192.0.2.7', { 'user-agent': long }),
    })
    expect(records[0]?.userAgent).toBe(long.slice(0, 512))
    expect(records[0]).toMatchObject({ trafficClass: 'human', signals: [], browser: 'chrome' })
  })

  it('looks an address up and records it without its brackets or port', async () => {
    const asked: string[] = []
    const spy: IpLookup = {
      lookup: (ip) => {
        asked.push(ip)
        return IPDATA.lookup(ip)
      },
    }
    const { app, records } = harness([link()], { ipdata: spy })
    for (const ip of ['[2001:db8::7]:443', '[2001:db8::8]', '192.0.2.7:8080', '2001:db8::9']) {
      await app.inject({ method: 'GET', url: '/spring', headers: from(ip) })
    }
    expect(asked).toEqual(['2001:db8::7', '2001:db8::8', '192.0.2.7', '2001:db8::9'])
    expect(records.map((r) => r.ip)).toEqual(asked)
    expect(records[2]?.country).toBe('DE')
  })

  it('counts an address the same with or without brackets and a port', async () => {
    const { app, records } = harness([link()], {
      ipdata: IPDATA,
      settings: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 1 },
      rate: new RateCounter(),
    })
    await app.inject({ method: 'GET', url: '/spring', headers: from('[2001:db8::7]:443') })
    await app.inject({ method: 'GET', url: '/spring', headers: from('2001:db8::7') })
    expect(records.map((r) => r.trafficClass)).toEqual(['human', 'abuser'])
  })

  it('records an IPv4-mapped address as IPv4, and counts it with the plain form', async () => {
    const { app, records } = harness([link()], {
      ipdata: IPDATA,
      settings: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 1 },
      rate: new RateCounter(),
    })
    await app.inject({ method: 'GET', url: '/spring', headers: from('::ffff:198.51.100.7') })
    await app.inject({ method: 'GET', url: '/spring', headers: from('198.51.100.7') })
    expect(records.map((r) => [r.ip, r.country, r.trafficClass])).toEqual([
      ['198.51.100.7', 'FR', 'datacenter'],
      ['198.51.100.7', 'FR', 'abuser'],
    ])
  })

  it('records an IPv6 address in one form however the proxy writes it', async () => {
    const { app, records } = harness([link()], { ipdata: IPDATA })
    for (const ip of ['2001:DB8:0:0:0:0:0:7', '[2001:0db8::0007]:443']) {
      await app.inject({ method: 'GET', url: '/spring', headers: from(ip) })
    }
    expect(records.map((r) => r.ip)).toEqual(['2001:db8::7', '2001:db8::7'])
  })

  it('counts requests on a clock that never steps back, whatever the wall clock does', async () => {
    // The wall clock steps back an hour before every request; the count carries on.
    let wall = Date.now()
    const { app, records } = harness([link()], {
      ipdata: IPDATA,
      settings: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 2 },
      rate: new RateCounter(),
      now: () => {
        wall -= 3_600_000
        return new Date(wall)
      },
    })
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
    }
    expect(records.map((r) => r.trafficClass)).toEqual(['human', 'human', 'abuser'])
  })

  it('answers before the IP data is loaded, and uses it once the store has loaded it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-ipdata-'))
    try {
      const fetchedAt = new Date()
      const table = (id: 'country' | 'asn' | 'datacenter' | 'tor') => ({
        table: IPDATA.tables[id] as RangeTable,
        version: '2026-01',
        fetchedAt,
      })
      commitTables(dir, {
        country: table('country'),
        asn: table('asn'),
        datacenter: table('datacenter'),
        tor: table('tor'),
      })
      // Loading happens in the store, never in a request: the redirect reads
      // whatever the store holds, and nothing until it holds something.
      const store = new IpDataStore({ dir })
      const { app, records } = harness([link()], { ipdata: () => store.current() })
      const before = await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
      expect(before.statusCode).toBe(302)
      expect(await store.refresh()).toBe(true)
      await app.inject({ method: 'GET', url: '/spring', headers: from('192.0.2.7') })
      expect(records.map((r) => [r.trafficClass, r.country])).toEqual([
        ['unknown', null],
        ['human', 'DE'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
