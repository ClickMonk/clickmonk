import { ConcurrencyGate } from '@clickmonk/core'
import { type ClickHouseClient, createChClient } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from './http.js'
import { HOUR_MS, parseWindow } from './reports.js'
import { ADMIN_HOST, clockFrom, read, signedIn, testApp } from './testing.js'

const pool = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-24T12:00:00.000Z'))
let app: FastifyInstance
let cookie = ''

const LINK_A = '00000000-0000-4000-8000-0000000000a1'
const LINK_B = '00000000-0000-4000-8000-0000000000a2'
const DOMAIN = '00000000-0000-4000-8000-00000000000d'

/** One click as the shipper writes it, at a fixed instant inside the window below. */
const click = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  click_id: '01920000-0000-7000-8000-00000000000a',
  time: '2026-09-24 10:15:00.000',
  host: 'go.example.test',
  path: '/a',
  domain_id: DOMAIN,
  link_id: LINK_A,
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/',
  target_id: '00000000-0000-4000-8000-0000000000b1',
  visitor_id: 'v1',
  returning: 0,
  country: 'DE',
  region: '',
  city: '',
  geo_source: 'dbip',
  device: 'desktop',
  user_agent: 'ua',
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

/** The window every test below asks for, unless it is about the window itself. */
const WINDOW = 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'

const summary = (on: FastifyInstance, query = WINDOW) =>
  on.inject({ method: 'GET', url: `/api/reports/summary?${query}`, headers: read(cookie) })

beforeAll(async () => {
  await resetDatabases(pool, ch)
  await insert([
    click(),
    click({ click_id: '01920000-0000-7000-8000-00000000000b', visitor_id: 'v2', country: 'US' }),
    // The same visitor as the first, on another link: one visitor, two clicks.
    click({ click_id: '01920000-0000-7000-8000-00000000000c', link_id: LINK_B, path: '/b' }),
    // A bot, blocked, in the same hour, by the same visitor as the first. It
    // reached no target, so its target id is empty — which is also the only
    // empty dimension value in these fixtures.
    click({
      click_id: '01920000-0000-7000-8000-00000000000d',
      traffic_class: 'bot',
      action: 'block',
      outcome: 'blocked',
      step: 'classify',
      status: 403,
      signals: ['ua_bot'],
      destination: '',
      target_id: '',
    }),
    // An hour later, and outside the narrow window one test asks for.
    click({
      click_id: '01920000-0000-7000-8000-00000000000e',
      time: '2026-09-24 11:30:00.000',
      visitor_id: 'v3',
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

describe('GET /api/reports/summary', () => {
  it('counts the window, by click and by visitor', async () => {
    const r = await summary(app)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
      link: null,
      clicks: 5,
      visitors: 3,
      byClass: { human: 4, bot: 1 },
      byAction: { '': 4, block: 1 },
      byOutcome: { target: 4, blocked: 1 },
      newestHour: '2026-09-24T11:00:00.000Z',
    })
  })

  // Three clicks by two visitors, one of whom also clicked the other link:
  // the per-link visitor count is not a share of the install-wide one.
  it('counts one link when asked for one', async () => {
    const r = await summary(app, `${WINDOW}&link=${LINK_B}`)
    expect(r.json().clicks).toBe(1)
    expect(r.json().visitors).toBe(1)
    expect(r.json().link).toBe(LINK_B)
  })

  it('counts whole hours and says which hours it counted', async () => {
    const r = await summary(app, 'from=2026-09-24T10:30:00.000Z&to=2026-09-24T11:10:00.000Z')
    // Asked for 10:30 to 11:10; counted 10:00 to 12:00, which is both hours.
    expect(r.json().window).toEqual({
      from: '2026-09-24T10:00:00.000Z',
      to: '2026-09-24T12:00:00.000Z',
    })
    expect(r.json().clicks).toBe(5)
  })

  it('answers an empty window with zeroes rather than nothing', async () => {
    const r = await summary(app, 'from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z')
    expect(r.statusCode).toBe(200)
    expect(r.json().clicks).toBe(0)
    expect(r.json().visitors).toBe(0)
    expect(r.json().byClass).toEqual({})
  })

  it.each([
    ['no window at all', ''],
    ['only a start', 'from=2026-09-24T00:00:00.000Z'],
    ['a start that is not a time', 'from=yesterday&to=2026-09-25T00:00:00.000Z'],
    ['a time with no zone', 'from=2026-09-24T00:00:00&to=2026-09-25T00:00:00.000Z'],
    ['a backwards window', 'from=2026-09-25T00:00:00.000Z&to=2026-09-24T00:00:00.000Z'],
    ['an empty window', 'from=2026-09-24T00:00:00.000Z&to=2026-09-24T00:00:00.000Z'],
    ['a link that is not an id', `${WINDOW}&link=nope`],
    ['a field nobody knows', `${WINDOW}&account=1`],
  ])('refuses %s', async (_label, query) => {
    const r = await summary(app, query)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
  })

  it('refuses a window longer than four hundred days, and says how long it may be', async () => {
    const r = await summary(app, 'from=2025-01-01T00:00:00.000Z&to=2026-09-25T00:00:00.000Z')
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('window_too_long')
    expect(r.json().message).toContain('400 days')
  })

  it('needs a credential', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/reports/summary?${WINDOW}`,
      headers: { host: ADMIN_HOST },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
  })

  it('answers an API key, because a report is a read a script may make', async () => {
    // A key is minted through the API by the signed-in session, then used.
    const made = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { host: ADMIN_HOST, origin: `https://${ADMIN_HOST}`, cookie },
      payload: { name: 'reporting' },
    })
    const key = made.json().key as string
    const r = await app.inject({
      method: 'GET',
      url: `/api/reports/summary?${WINDOW}`,
      headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().clicks).toBe(5)
  })

  it('refuses when every report slot is taken, and says when to come back', async () => {
    const full = new ConcurrencyGate(0)
    const other = testApp(pool, clock, { ch, reportGate: full })
    try {
      const r = await summary(other)
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_reports')
      expect(r.headers['retry-after']).toBe('1')
    } finally {
      await other.close()
    }
  })

  // One slot, two reports in sequence: the second is answered only because the
  // first gave its slot back. With the shipped two slots a leak would take
  // three requests to show, so the gate is shrunk to the one that proves it.
  it('gives a slot back, so the next report is answered', async () => {
    const one = new ConcurrencyGate(1)
    const other = testApp(pool, clock, { ch, reportGate: one })
    try {
      for (const attempt of ['first', 'second']) {
        const r = await summary(other)
        expect(r.statusCode, attempt).toBe(200)
      }
    } finally {
      await other.close()
    }
  })
})

// The route cannot reach this: `from` is a datetime in the schema, so an
// unreadable date is a 400 before the parser sees it. The parser is exported
// and the chart and the log will call it too, so the bound lives in the
// function and is checked there — the same rule as every other bound a later
// caller could reach directly.
describe('parseWindow', () => {
  it('refuses a date it cannot read, rather than returning a window of NaN', () => {
    // The guard for this is `!(toMs > fromMs)`. Written the natural way round,
    // as `toMs <= fromMs`, this call returns a window of NaN: every later check
    // compares with `>` and every comparison with NaN is false, so the length
    // bound and the bucket ceiling both pass it through.
    let thrown: unknown
    try {
      parseWindow({ from: 'yesterday', to: '2026-09-25T00:00:00.000Z' }, { alignMs: HOUR_MS })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(HttpError)
    expect((thrown as HttpError).status).toBe(400)
    expect((thrown as HttpError).code).toBe('invalid_query')
  })
})

describe('when ClickHouse is not there', () => {
  let dead: ClickHouseClient
  let deadApp: FastifyInstance

  beforeEach(() => {
    // A port nothing listens on, in the range no service in this repository
    // binds. The client does not connect until it is asked to.
    dead = createChClient({
      url: 'http://127.0.0.1:1',
      username: 'clickmonk',
      password: 'clickmonk',
      database: 'clickmonk_test',
      requestTimeoutMs: 2000,
    })
    deadApp = testApp(pool, clock, { ch: dead })
  })

  afterEach(async () => {
    await deadApp.close()
    await dead.close()
  })

  it('answers a report 503 and names the store, not an internal error', async () => {
    const r = await summary(deadApp)
    expect(r.statusCode).toBe(503)
    expect(r.json().error).toBe('reporting_unavailable')
    // Nothing about the failure itself: a connection refused to a named host
    // and port is an address this service is not obliged to hand out.
    expect(r.json().message).not.toContain('127.0.0.1')
  })

  it('still answers everything that does not read it', async () => {
    const r = await deadApp.inject({ method: 'GET', url: '/api/links', headers: read(cookie) })
    expect(r.statusCode).toBe(200)
  })

  it('answers a report 503 when there is no client at all', async () => {
    const none = testApp(pool, clock)
    try {
      const r = await summary(none)
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('reporting_unavailable')
    } finally {
      await none.close()
    }
  })
})
