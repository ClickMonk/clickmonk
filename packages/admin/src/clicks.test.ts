import { ClickHouseLogLevel } from '@clickhouse/client'
import { ConcurrencyGate } from '@clickmonk/core'
import { type ClickHouseClient, createChClient } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_HOST, clockFrom, read, signedIn, testApp } from './testing.js'

const pool = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-24T12:00:00.000Z'))
let app: FastifyInstance
let cookie = ''

const LINK_A = '00000000-0000-4000-8000-0000000000a1'
const LINK_B = '00000000-0000-4000-8000-0000000000a2'
const DOMAIN = '00000000-0000-4000-8000-00000000000d'
const TARGET = '00000000-0000-4000-8000-0000000000b1'

const click = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  click_id: '01920000-0000-7000-8000-000000000001',
  time: '2026-09-24 10:00:00.000',
  host: 'go.example.test',
  path: '/a',
  domain_id: DOMAIN,
  link_id: LINK_A,
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/?c=01920000-0000-7000-8000-000000000001',
  target_id: TARGET,
  visitor_id: 'v1',
  returning: 0,
  country: 'DE',
  region: '',
  city: '',
  geo_source: 'dbip',
  device: 'desktop',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
  referrer: 'https://blog.example.com/post',
  ip: '198.51.100.77',
  cap_unchecked: 0,
  traffic_class: 'human',
  signals: [],
  action: '',
  os: 'windows',
  browser: 'chrome',
  asn: 64500,
  ...over,
})

const insert = (values: Record<string, unknown>[]) =>
  ch.insert({ table: 'clicks', values, format: 'JSONEachRow' })

const WINDOW = 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'

/** The day before, which nothing above reads: see the block at the end of the file. */
const DAY_BEFORE = 'from=2026-09-23T00:00:00.000Z&to=2026-09-24T00:00:00.000Z'

beforeAll(async () => {
  await resetDatabases(pool, ch)
  await insert([
    click(),
    click({
      click_id: '01920000-0000-7000-8000-000000000002',
      time: '2026-09-24 10:01:00.000',
      link_id: LINK_B,
      path: '/b',
      country: 'US',
      visitor_id: 'v2',
      returning: 1,
      ip: '2001:db8:1234:5678:9abc:def0:1234:5678',
      referrer: '',
      asn: 0,
    }),
    click({
      click_id: '01920000-0000-7000-8000-000000000003',
      time: '2026-09-24 10:02:00.000',
      traffic_class: 'bot',
      action: 'block',
      outcome: 'blocked',
      step: 'classify',
      status: 403,
      destination: '',
      target_id: '',
      country: '',
      geo_source: '',
      signals: ['ua_bot', 'head'],
      ip: '',
      cap_unchecked: 1,
    }),
    // A day earlier, so outside every window above, and recorded through a
    // proxy that spelled the address as a bracketed literal with a port. The
    // redirect writes a canonical bare address, so this is a claim about what
    // the column may hold — a plain String bounded only in length, written by
    // whatever shipped the record — rather than about what the redirect writes
    // today, and that is exactly why it earns a test. Its own window, because a
    // fifth row inside the day would move every count and every page boundary
    // the block above asserts.
    click({
      click_id: '01920000-0000-7000-8000-000000000004',
      time: '2026-09-23 10:00:00.000',
      ip: '[2001:db8:1234:5678:9abc:def0:1234:5678]:443',
    }),
  ])
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

describe('GET /api/clicks', () => {
  it('shows a click whole, newest first, with the address as a network', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.window).toEqual({
      from: '2026-09-24T00:00:00.000Z',
      to: '2026-09-25T00:00:00.000Z',
    })
    expect(body.nextCursor).toBeNull()
    expect(body.clicks).toHaveLength(3)
    expect(body.clicks[2]).toEqual({
      clickId: '01920000-0000-7000-8000-000000000001',
      at: '2026-09-24T10:00:00.000Z',
      host: 'go.example.test',
      path: '/a',
      domainId: DOMAIN,
      linkId: LINK_A,
      outcome: 'target',
      step: 'destination',
      status: 302,
      destination: 'https://example.com/?c=01920000-0000-7000-8000-000000000001',
      targetId: TARGET,
      visitorId: 'v1',
      returning: false,
      country: 'DE',
      region: null,
      city: null,
      geoSource: 'dbip',
      device: 'desktop',
      os: 'windows',
      browser: 'chrome',
      asn: 64500,
      class: 'human',
      signals: [],
      action: null,
      referrer: 'https://blog.example.com/post',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
      network: '198.51.100.0/24',
      capUnchecked: false,
    })
  })

  /**
   * The worker deletes a spool segment only after ClickHouse accepts it, so a
   * crash in between ships the same segment again: two rows identical to the
   * byte, until a merge collapses them.
   *
   * The duplicate is written **here and in its own INSERT**, not with the
   * fixture. One INSERT is one part and the engine collapses equal sort keys as
   * it writes a part, so a duplicate inside the fixture's array is gone before
   * any test runs — and `FINAL` then has nothing to do, which is how this test
   * passed with `FINAL` dropped. A second INSERT is a second part, and the raw
   * count asserted below is what says the duplicate was still there when the log
   * was read: a background merge may collapse it at any moment, and that count
   * failing is the right answer to a fixture this test can no longer see.
   */
  it('shows a click that was shipped twice once', async () => {
    await insert([click()])
    const rs = await ch.query({ query: 'SELECT count() AS n FROM clicks', format: 'JSONEachRow' })
    // Five rows: four from the fixture — three in this window and the day
    // before's — plus the copy just written. The message is the whole point of
    // asserting this before reading the log: four rows here means a background
    // merge collapsed the pair between the INSERT and this count, which is a
    // race in the fixture and not a regression in the query below.
    expect(
      await rs.json(),
      'a background merge collapsed the re-shipped copy before the log was read, so this test could not see whether FINAL deduplicated anything. That is a race in the fixture, not a failure of the query. If it recurs, give this suite a ClickHouse database of its own; never SYSTEM STOP MERGES, which these shared test databases would hand to every other suite.',
    ).toEqual([{ n: '5' }])
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    const ids = r.json().clicks.map((c: { clickId: string }) => c.clickId)
    expect(ids).toEqual([
      '01920000-0000-7000-8000-000000000003',
      '01920000-0000-7000-8000-000000000002',
      '01920000-0000-7000-8000-000000000001',
    ])
  })

  it('shows an IPv6 client as its /64 and an empty one as nothing', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    const clicks = r.json().clicks as { clickId: string; network: string | null }[]
    const byId = new Map(clicks.map((c) => [c.clickId, c]))
    expect(byId.get('01920000-0000-7000-8000-000000000002')?.network).toBe(
      '2001:db8:1234:5678::/64',
    )
    // Blanked by the retention pass, or never recorded: null, not an empty
    // string a reader might print as an address.
    expect(byId.get('01920000-0000-7000-8000-000000000003')?.network).toBeNull()
  })

  it('turns every empty column into nothing rather than an empty string', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: read(cookie),
    })
    // The whole object, not a subset: a partial matcher passes against a
    // response that also carries a field nobody meant to send — an `ip`, for
    // instance — which is the one thing every assertion about this response has
    // to be able to see.
    expect(r.json().clicks[0]).toEqual({
      clickId: '01920000-0000-7000-8000-000000000003',
      at: '2026-09-24T10:02:00.000Z',
      host: 'go.example.test',
      path: '/a',
      domainId: DOMAIN,
      linkId: LINK_A,
      outcome: 'blocked',
      step: 'classify',
      status: 403,
      destination: null,
      targetId: null,
      visitorId: 'v1',
      returning: false,
      country: null,
      region: null,
      city: null,
      geoSource: null,
      device: 'desktop',
      os: 'windows',
      browser: 'chrome',
      asn: 64500,
      class: 'bot',
      signals: ['ua_bot', 'head'],
      action: 'block',
      referrer: 'https://blog.example.com/post',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
      network: null,
      capUnchecked: true,
    })
    // Three fields of the middle click, read one at a time rather than as a
    // subset of it: each is a column whose empty or zero value means "not
    // known" and must not come back as `0` or `''`.
    const second = r.json().clicks[1]
    expect(second.asn).toBeNull()
    expect(second.referrer).toBeNull()
    expect(second.returning).toBe(true)
  })

  /**
   * The whole response, with the link filter carrying a link id rather than the
   * null every other test here leaves it as.
   *
   * `link` is echoed from the parsed window, and an echoed field asserted only
   * where it holds its least interesting value can be replaced by a constant
   * with the rest of the suite green. So this one is asserted whole, at a value
   * nothing else in the file sends.
   */
  it('echoes the link it was asked for, and nothing else, whole', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&link=${LINK_B}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
      link: LINK_B,
      clicks: [
        {
          clickId: '01920000-0000-7000-8000-000000000002',
          at: '2026-09-24T10:01:00.000Z',
          host: 'go.example.test',
          path: '/b',
          domainId: DOMAIN,
          linkId: LINK_B,
          outcome: 'target',
          step: 'destination',
          status: 302,
          // The destination the base row carries: every fixture click here is
          // copied from the first one, and only the fields a case is about are
          // overridden.
          destination: 'https://example.com/?c=01920000-0000-7000-8000-000000000001',
          targetId: TARGET,
          visitorId: 'v2',
          returning: true,
          country: 'US',
          region: null,
          city: null,
          geoSource: 'dbip',
          device: 'desktop',
          os: 'windows',
          browser: 'chrome',
          asn: null,
          class: 'human',
          signals: [],
          action: null,
          referrer: null,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
          network: '2001:db8:1234:5678::/64',
          capUnchecked: false,
        },
      ],
      nextCursor: null,
    })
  })

  it.each([
    ['link', `link=${LINK_B}`, ['01920000-0000-7000-8000-000000000002']],
    ['class', 'class=bot', ['01920000-0000-7000-8000-000000000003']],
    ['outcome', 'outcome=blocked', ['01920000-0000-7000-8000-000000000003']],
    ['country', 'country=US', ['01920000-0000-7000-8000-000000000002']],
  ])('filters by %s', async (_label, filter, expected) => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&${filter}`,
      headers: read(cookie),
    })
    expect(r.json().clicks.map((c: { clickId: string }) => c.clickId)).toEqual(expected)
  })

  it('takes every filter at once', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&link=${LINK_A}&class=bot&outcome=blocked`,
      headers: read(cookie),
    })
    expect(r.json().clicks).toHaveLength(1)
  })

  it('uses the window exactly as it was given, to the millisecond', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/clicks?from=2026-09-24T10:01:00.000Z&to=2026-09-24T10:02:00.000Z',
      headers: read(cookie),
    })
    // Half-open: the click at 10:01 is in, the one at 10:02 is not.
    expect(r.json().clicks.map((c: { clickId: string }) => c.clickId)).toEqual([
      '01920000-0000-7000-8000-000000000002',
    ])
    expect(r.json().window).toEqual({
      from: '2026-09-24T10:01:00.000Z',
      to: '2026-09-24T10:02:00.000Z',
    })
  })

  it('pages with a cursor, and stops without one', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&limit=2`,
      headers: read(cookie),
    })
    expect(first.json().clicks).toHaveLength(2)
    const cursor = first.json().nextCursor as string
    expect(cursor).toMatch(/^\d+\.[0-9a-f-]{36}$/)
    const second = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: read(cookie),
    })
    expect(second.json().clicks.map((c: { clickId: string }) => c.clickId)).toEqual([
      '01920000-0000-7000-8000-000000000001',
    ])
    expect(second.json().nextCursor).toBeNull()
  })

  it.each([
    ['a cursor that is not one', 'cursor=nonsense'],
    ['a cursor with no id', 'cursor=1758708000000.'],
    ['a cursor whose id is not an id', 'cursor=1758708000000.not-a-uuid-at-all-not-at-all-no-x'],
    ['a class nobody has', 'class=spider'],
    ['an outcome nobody has', 'outcome=maybe'],
    ['a lower-case country', 'country=de'],
    ['a country that is not a country code', 'country=DEU'],
    ['a page past the ceiling', 'limit=201'],
    ['a page of nothing', 'limit=0'],
    // Its own case, and the one whose status code is the point: `2.5` coerces
    // to a number where `all` does not, so without `.int()` it is interpolated
    // as `LIMIT 3.5`, the store answers an error, and the caller is told
    // reporting is unavailable on this install rather than that their own field
    // was wrong.
    ['a page that is not a whole number', 'limit=2.5'],
    ['a field nobody knows', 'ip=198.51.100.77'],
  ])('refuses %s', async (_label, extra) => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&${extra}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
  })

  it('refuses a window longer than four hundred days', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/clicks?from=2025-01-01T00:00:00.000Z&to=2026-09-25T00:00:00.000Z',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('window_too_long')
  })

  it('needs a credential', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}`,
      headers: { host: ADMIN_HOST },
    })
    expect(r.statusCode).toBe(401)
  })

  it('refuses when every report slot is taken', async () => {
    const other = testApp(pool, clock, { ch, reportGate: new ConcurrencyGate(0) })
    try {
      const r = await other.inject({
        method: 'GET',
        url: `/api/clicks?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_reports')
    } finally {
      await other.close()
    }
  })
})

/**
 * An address the way a proxy may have spelled it, in a window of its own.
 *
 * `truncateIp` answers null for anything that is not bare address text, a port
 * and a bracketed literal included, and the stored column is a plain String the
 * record schema bounds only in length. So the address is run through
 * `addressOnly` first; without that, a click recorded this way reads as "no
 * network" — the same answer as a click whose address the retention pass
 * blanked, which is the one thing the two must not share.
 */
describe('GET /api/clicks, an address with brackets and a port', () => {
  it('shows it as the network it came from', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${DAY_BEFORE}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(
      r
        .json()
        .clicks.map((c: { clickId: string; network: string | null }) => [c.clickId, c.network]),
    ).toEqual([['01920000-0000-7000-8000-000000000004', '2001:db8:1234:5678::/64']])
  })
})

describe('the log when ClickHouse is not there', () => {
  let dead: ClickHouseClient

  beforeEach(() => {
    // A port nothing listens on, in the range no service in this repository
    // binds. The client does not connect until it is asked to, and its own
    // logger is off: the refused connection is what these tests arrange, so
    // printing it on every green run teaches a reader to skim the stderr a real
    // failure appears in.
    dead = createChClient({
      url: 'http://127.0.0.1:1',
      username: 'clickmonk',
      password: 'clickmonk',
      database: 'clickmonk_test',
      requestTimeoutMs: 2000,
      logLevel: ClickHouseLogLevel.OFF,
    })
  })

  afterEach(async () => {
    await dead.close()
  })

  it('answers 503 and names the store, not an internal error', async () => {
    const on = testApp(pool, clock, { ch: dead })
    try {
      const r = await on.inject({
        method: 'GET',
        url: `/api/clicks?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('reporting_unavailable')
      expect(r.json().message).not.toContain('127.0.0.1')
    } finally {
      await on.close()
    }
  })

  /**
   * The credential is asked for before the queue, and this is what pins it
   * there rather than merely pinning that it is asked for at all.
   *
   * Three positions, three answers, and the 401 test above can only see the
   * first of them. With the gate full and the store unreachable: asked for
   * after the query, an unauthenticated request scans the window it chose and
   * gets a 503; asked for inside the gate but before the query, it takes a
   * report slot and gets a 429, so a flood of them answers the operator 429
   * with no row read. Only asked for before both is the answer 401 — and the
   * log line a failed query writes is asserted absent as well, because the
   * status alone cannot tell a refusal from a query that happened to fail.
   */
  it('refuses without a credential before taking a slot or reading anything', async () => {
    const lines: string[] = []
    const on = testApp(pool, clock, {
      ch: dead,
      reportGate: new ConcurrencyGate(0),
      log: {
        level: 'error',
        stream: {
          write(line: string) {
            lines.push(line)
          },
        },
      },
    })
    try {
      const r = await on.inject({
        method: 'GET',
        url: `/api/clicks?${WINDOW}`,
        headers: { host: ADMIN_HOST },
      })
      expect(r.statusCode).toBe(401)
      expect(r.json().error).toBe('unauthenticated')
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    } finally {
      await on.close()
    }
  })
})
