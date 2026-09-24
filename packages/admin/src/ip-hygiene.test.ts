import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clockFrom, read, signedIn, testApp } from './testing.js'

/**
 * No response carries a **visitor's** whole address, and no click in a response
 * has a field called `ip`.
 *
 * It is one file rather than an assertion inside each route's suite because the
 * rule is about the surface: a route added later that selects a click's `ip` and
 * forgets to truncate it is caught here, by a test nobody has to remember to
 * extend, as long as its URL is in the list below.
 *
 * What it does not say is that no response anywhere names an address. `GET
 * /api/sessions` is in the list and hands the operator the addresses their own
 * sessions were opened from, whole and on purpose; it passes because the
 * addresses in these fixtures are visitors' addresses, in ClickHouse, which the
 * session list has no way to reach. So the two addresses below are the subject of
 * the check, not merely two strings that happen not to appear: a route that reads
 * a click and prints its address whole fails, and the operator's own session
 * addresses go on being shown.
 */
const pool = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-24T12:00:00.000Z'))
let app: FastifyInstance
let cookie = ''

/** The whole address every fixture below was recorded with. */
const HOST_ADDRESS = '198.51.100.77'
const V6_ADDRESS = '2001:db8:1234:5678:9abc:def0:1234:5678'
const WINDOW = 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'

// Every GET behind the credential, so that the check is about the surface and
// not about the routes somebody thought of. `/health` is the one GET left out:
// it is in front of the credential and answers a fixed status with no data of
// its own. A read added later belongs here.
const READS = [
  `/api/clicks?${WINDOW}`,
  `/api/reports/summary?${WINDOW}`,
  `/api/reports/timeseries?${WINDOW}&bucket=hour`,
  `/api/reports/breakdown?${WINDOW}&dimension=country`,
  '/api/links',
  '/api/domains',
  '/api/alerts',
  '/api/keys',
  '/api/settings',
  '/api/sessions',
  '/api/me',
]

beforeAll(async () => {
  await resetDatabases(pool, ch)
  // Two clicks, one per family, each with its whole address stored.
  await ch.insert({
    table: 'clicks',
    values: [
      {
        click_id: '01920000-0000-7000-8000-000000000001',
        time: '2026-09-24 10:00:00.000',
        host: 'go.example.test',
        path: '/a',
        domain_id: '00000000-0000-4000-8000-00000000000d',
        link_id: '00000000-0000-4000-8000-0000000000a1',
        outcome: 'target',
        step: 'destination',
        status: 302,
        destination: 'https://example.com/',
        target_id: '',
        visitor_id: 'v1',
        returning: 0,
        country: 'DE',
        region: '',
        city: '',
        geo_source: 'dbip',
        device: 'desktop',
        user_agent: 'ua',
        referrer: '',
        ip: HOST_ADDRESS,
        cap_unchecked: 0,
        traffic_class: 'human',
        signals: [],
        action: '',
        os: 'windows',
        browser: 'chrome',
        asn: 64500,
      },
      {
        click_id: '01920000-0000-7000-8000-000000000002',
        time: '2026-09-24 10:01:00.000',
        host: 'go.example.test',
        path: '/a',
        domain_id: '00000000-0000-4000-8000-00000000000d',
        link_id: '00000000-0000-4000-8000-0000000000a1',
        outcome: 'target',
        step: 'destination',
        status: 302,
        destination: 'https://example.com/',
        target_id: '',
        visitor_id: 'v2',
        returning: 0,
        country: 'DE',
        region: '',
        city: '',
        geo_source: 'dbip',
        device: 'desktop',
        user_agent: 'ua',
        referrer: '',
        ip: V6_ADDRESS,
        cap_unchecked: 0,
        traffic_class: 'human',
        signals: [],
        action: '',
        os: 'windows',
        browser: 'chrome',
        asn: 64500,
      },
    ],
    format: 'JSONEachRow',
  })
})

beforeEach(async () => {
  app = testApp(pool, clock, { ch })
  cookie = await signedIn(app, pool, clock.now())
})

afterEach(async () => {
  await app.close()
  await pool.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

describe('no response carries a whole address', () => {
  it.each(READS)('%s', async (url) => {
    const r = await app.inject({ method: 'GET', url, headers: read(cookie) })
    expect(r.statusCode).toBe(200)
    // A `not.toContain` against an empty body passes without reading anything,
    // so the body is asserted to be there first: a route that answered `{}`
    // would otherwise satisfy both lines below.
    expect(r.body.length).toBeGreaterThan(2)
    expect(r.body).not.toContain(HOST_ADDRESS)
    expect(r.body).not.toContain(V6_ADDRESS)
  })

  it('shows the network instead, in both families', async () => {
    const log = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    expect(log.body).toContain('198.51.100.0/24')
    expect(log.body).toContain('2001:db8:1234:5678::/64')
  })

  it('has no field called ip anywhere in the log', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    // Both fixture clicks, so the loop below has something to read: a loop over
    // an empty list asserts nothing at all.
    expect(r.json().clicks).toHaveLength(2)
    for (const click of r.json().clicks as Record<string, unknown>[]) {
      expect(Object.keys(click)).not.toContain('ip')
      expect(Object.keys(click)).toContain('network')
    }
  })
})
