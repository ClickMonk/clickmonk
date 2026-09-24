import { ClickHouseLogLevel } from '@clickhouse/client'
import { ConcurrencyGate } from '@clickmonk/core'
import { type ClickHouseClient, createChClient } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from './http.js'
import { HOUR_MS, newestHourOrNull, parseWindow } from './reports.js'
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
    // An hour later, and outside the narrow window one test asks for. The same
    // visitor as the first, which is what makes a day's visitor count something
    // other than the sum of its hours: two visitors at ten and one at eleven,
    // and two for the day. With a third visitor here the two arithmetics agree
    // and neither the chart nor the summary would notice being summed.
    click({
      click_id: '01920000-0000-7000-8000-00000000000e',
      time: '2026-09-24 11:30:00.000',
    }),
    // In the hour that *starts* at the aligned end of the window below, which
    // that window must not count: half-open is the only reason two adjacent
    // reports do not both claim this click. Its own visitor, so an inclusive
    // upper bound moves the visitor count as well as the clicks.
    click({
      click_id: '01920000-0000-7000-8000-00000000000f',
      time: '2026-09-25 00:30:00.000',
      visitor_id: 'v4',
    }),
  ])
  // The same segment again, byte for byte: the worker deletes a spool segment
  // only after ClickHouse accepts it, so a crash in between ships it twice.
  // Every number a report gives is a set over click ids, so the second copy
  // must change none of them — the invariant the whole rollup design rests on,
  // and one no fixture of distinct ids can see.
  await insert([click()])
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
      // Two, not three: the click an hour later is the same visitor as the
      // first, so the window's visitors are not its hours' visitors added up.
      visitors: 2,
      byClass: { human: 4, bot: 1 },
      byAction: { '': 4, block: 1 },
      byOutcome: { target: 4, blocked: 1 },
      // The whole table, not this window: the click half an hour past the end
      // of it is the newest hour the install has.
      newestHour: '2026-09-25T00:00:00.000Z',
    })
  })

  // The other end of the same clause, and the end that goes unnoticed: an
  // inclusive `to` makes two adjacent reports both count the click above, so a
  // month read as twelve windows counts eleven hours twice.
  it('ends the window before the hour it names', async () => {
    const r = await summary(app, 'from=2026-09-24T23:00:00.000Z&to=2026-09-25T00:00:00.000Z')
    expect(r.statusCode).toBe(200)
    expect(r.json().clicks).toBe(0)
    expect(r.json().visitors).toBe(0)
    // And the hour it stops before does hold a click, so the zero above is the
    // bound rather than an empty table.
    expect(r.json().newestHour).toBe('2026-09-25T00:00:00.000Z')
  })

  // One click by a visitor who also clicked the other link, so the per-link
  // visitor count is not a share of the install-wide one.
  //
  // Asserted whole, and this is the response to assert whole: the one above
  // carries `link: null`, which an echo replaced by a constant would still
  // answer. A filter the response does not really carry is the worst of the
  // three answers — the numbers are for one link and the body says so about
  // nothing in particular.
  it('counts one link when asked for one', async () => {
    const r = await summary(app, `${WINDOW}&link=${LINK_B}`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
      link: LINK_B,
      clicks: 1,
      visitors: 1,
      byClass: { human: 1 },
      byAction: { '': 1 },
      byOutcome: { target: 1 },
      // The whole install's freshness, which a link filter does not narrow.
      newestHour: '2026-09-25T00:00:00.000Z',
    })
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

describe('GET /api/reports/timeseries', () => {
  it('gives one bucket an hour, including the hours with nothing in them', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T09:00:00.000Z&to=2026-09-24T13:00:00.000Z&bucket=hour',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T09:00:00.000Z', to: '2026-09-24T13:00:00.000Z' },
      link: null,
      bucket: 'hour',
      buckets: [
        { at: '2026-09-24T09:00:00.000Z', clicks: 0, visitors: 0 },
        { at: '2026-09-24T10:00:00.000Z', clicks: 4, visitors: 2 },
        { at: '2026-09-24T11:00:00.000Z', clicks: 1, visitors: 1 },
        { at: '2026-09-24T12:00:00.000Z', clicks: 0, visitors: 0 },
      ],
    })
  })

  it('gives one bucket a day, and counts a visitor across the hours of that day once', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    // Whole, because this is the response where `bucket` is off the value the
    // hourly test above asserts: an echo replaced by the constant `'hour'`
    // answers that one correctly and this one wrongly.
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
      link: null,
      bucket: 'day',
      buckets: [
        // Five clicks by two visitors. One of them clicked in both hours and is
        // one visitor for the day, so the day's number is not the two hourly
        // numbers added up: those are 2 and 1, and this is 2.
        { at: '2026-09-24T00:00:00.000Z', clicks: 5, visitors: 2 },
      ],
    })
  })

  // The bucket the window's end names is the one it stops before, the same way
  // the summary's is: with `<= to` this day chart would carry a second bucket
  // holding the click at 2026-09-25 00:30, and two adjacent charts drawn a day
  // apart would each show it.
  it('stops before the bucket its end names', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(r.json().buckets).toHaveLength(1)
    // And the day it stops before does hold a click, so the single bucket is
    // the bound rather than an empty table beyond it.
    const next = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-25T00:00:00.000Z&to=2026-09-26T00:00:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(next.json().buckets).toEqual([
      { at: '2026-09-25T00:00:00.000Z', clicks: 1, visitors: 1 },
    ])
  })

  it('aligns a day chart to whole days, and says so', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T10:30:00.000Z&to=2026-09-24T11:30:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(r.json().window).toEqual({
      from: '2026-09-24T00:00:00.000Z',
      to: '2026-09-25T00:00:00.000Z',
    })
    expect(r.json().buckets).toHaveLength(1)
  })

  // Whole for the same reason the summary's link test is whole: the only other
  // body this block asserts entirely carries `link: null`.
  it('counts one link when asked for one', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?from=2026-09-24T10:00:00.000Z&to=2026-09-24T11:00:00.000Z&bucket=hour&link=${LINK_B}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-24T10:00:00.000Z', to: '2026-09-24T11:00:00.000Z' },
      link: LINK_B,
      bucket: 'hour',
      buckets: [{ at: '2026-09-24T10:00:00.000Z', clicks: 1, visitors: 1 }],
    })
  })

  it('refuses more buckets than one response carries, and says to ask for days', async () => {
    const r = await app.inject({
      method: 'GET',
      // A hundred days of hours: 2,400 buckets, past the ceiling of 2,000.
      url: '/api/reports/timeseries?from=2026-06-16T00:00:00.000Z&to=2026-09-24T00:00:00.000Z&bucket=hour',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('too_many_buckets')
    expect(r.json().message).toContain('bucket=day')
  })

  // The ceiling itself, at the two points either side of it. The tests around
  // this one reach 2,400 and 100, so the comparison could be written `>=` — one
  // bucket tighter than the number the message promises — and nothing would
  // notice. Both windows are written out rather than computed from
  // MAX_REPORT_BUCKETS: a bound derived from the constant it is testing moves
  // when the constant does and goes on passing.
  it('takes the most buckets it will return, and refuses one more', async () => {
    // 2026-07-02 16:00 to 2026-09-24 00:00 is 2,000 hours: 704 left in July,
    // 744 in August, 552 in September.
    const at = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-07-02T16:00:00.000Z&to=2026-09-24T00:00:00.000Z&bucket=hour',
      headers: read(cookie),
    })
    expect(at.statusCode).toBe(200)
    expect(at.json().buckets).toHaveLength(2000)
    // One hour earlier is 2,001.
    const over = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-07-02T15:00:00.000Z&to=2026-09-24T00:00:00.000Z&bucket=hour',
      headers: read(cookie),
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toBe('too_many_buckets')
  })

  it('takes a hundred days of days, which is inside the ceiling', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-06-16T00:00:00.000Z&to=2026-09-24T00:00:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    const buckets = r.json().buckets as { at: string; clicks: number; visitors: number }[]
    expect(buckets).toHaveLength(100)
    expect(buckets[0]?.at).toBe('2026-06-16T00:00:00.000Z')
    expect(buckets[99]?.at).toBe('2026-09-23T00:00:00.000Z')
    // Every fixture click is on the 24th, which is the instant this window
    // ends at, so every one of the hundred buckets is a real zero rather than
    // a row that was not returned.
    expect(buckets.reduce((n, b) => n + b.clicks, 0)).toBe(0)
  })

  it.each([
    ['no bucket at all', 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'],
    [
      'a bucket nobody has',
      'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=week',
    ],
    [
      'a field nobody knows',
      'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=hour&tz=CET',
    ],
  ])('refuses %s', async (_label, query) => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?${query}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
  })

  // The status alone does not pin the enum. With a plain string in its place an
  // unknown bucket is still a 400, from the wrong guard: no bucket size is found
  // for a name nobody has, the alignment becomes NaN, and the caller is told
  // their `to` is not after their `from` — about a field they got right. So what
  // pins the enum is the field the refusal names.
  it('names the bucket when the bucket is one nobody has', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=week',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('bucket')
  })

  // Its own test and not the summary's: the credential is asked for per route
  // here, with no hook over all of them, so a route that forgot to ask would be
  // an unauthenticated read of every click the install has and the summary's
  // test would still be green.
  it('needs a credential', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=hour',
      headers: { host: ADMIN_HOST },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
  })

  it('refuses when every report slot is taken', async () => {
    const other = testApp(pool, clock, { ch, reportGate: new ConcurrencyGate(0) })
    try {
      const r = await other.inject({
        method: 'GET',
        url: '/api/reports/timeseries?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&bucket=hour',
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_reports')
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

  // The link's shape belongs here for the same reason the length does. Bound
  // into a query as a UUID, a link that is not one comes back from the store as
  // a failure, so a caller reaching this function without the route's schema
  // would be told reporting is unavailable when what is wrong is their field.
  it('refuses a link that is not an id, whatever schema the caller came through', () => {
    let thrown: unknown
    try {
      parseWindow(
        { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z', link: 'nope' },
        { alignMs: HOUR_MS },
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(HttpError)
    expect((thrown as HttpError).status).toBe(400)
    expect((thrown as HttpError).code).toBe('invalid_query')
  })
})

describe('the newest hour the install holds', () => {
  it('is null rather than the epoch when the rollup holds nothing', () => {
    expect(newestHourOrNull('1970-01-01 00:00:00')).toBeNull()
    expect(newestHourOrNull('')).toBeNull()
    expect(newestHourOrNull(undefined)).toBeNull()
    expect(newestHourOrNull('2026-09-24 11:00:00')).toBe('2026-09-24T11:00:00.000Z')
  })

  // The claim that branch rests on, asked of the store rather than assumed: an
  // aggregate with no GROUP BY answers exactly one row however empty the range,
  // and max() over no rows is the zero of the column's type. It is also why the
  // summary's totals need no fallback of their own.
  it('is the epoch, in one row, when ClickHouse is asked over no rows at all', async () => {
    const rs = await ch.query({
      query: `SELECT toString(max(hour)) AS newest, count() AS seen
                FROM clicks_hourly WHERE hour >= '2099-01-01 00:00:00'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ newest: string; seen: string }>()
    expect(rows.length).toBe(1)
    expect(rows[0]?.newest).toBe('1970-01-01 00:00:00')
    expect(rows[0]?.seen).toBe('0')
  })
})

describe('when ClickHouse is not there', () => {
  let dead: ClickHouseClient
  let deadApp: FastifyInstance

  beforeEach(() => {
    // A port nothing listens on, in the range no service in this repository
    // binds. The client does not connect until it is asked to.
    //
    // Its own logger is off, as the shipper's unreachable client is: the
    // refused connection is what these tests arrange, so printing it on every
    // green run teaches a reader to skim the stderr a real failure appears in.
    // What this service logged is asserted below, not printed.
    dead = createChClient({
      url: 'http://127.0.0.1:1',
      username: 'clickmonk',
      password: 'clickmonk',
      database: 'clickmonk_test',
      requestTimeoutMs: 2000,
      logLevel: ClickHouseLogLevel.OFF,
    })
    deadApp = testApp(pool, clock, { ch: dead })
  })

  afterEach(async () => {
    await deadApp.close()
    await dead.close()
  })

  /**
   * An app on the unreachable client, with its error log captured.
   *
   * Every refusal that has to come *before* a query is asked of this app.
   * Against a store that cannot answer, anything reaching it is a 503, so a
   * refusal's own status is what says nothing was asked — and the log line the
   * query failure would have written is asserted absent as well, because a
   * guard moved after the query would otherwise leave only the status to tell
   * the two apart.
   */
  const onDeadWithLog = async (
    fn: (on: FastifyInstance, lines: string[]) => Promise<void>,
  ): Promise<void> => {
    const lines: string[] = []
    const on = testApp(pool, clock, {
      ch: dead,
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
      await fn(on, lines)
    } finally {
      await on.close()
    }
  }

  it('answers a report 503 and names the store, not an internal error', async () => {
    const r = await summary(deadApp)
    expect(r.statusCode).toBe(503)
    expect(r.json().error).toBe('reporting_unavailable')
    // Nothing about the failure itself: a connection refused to a named host
    // and port is an address this service is not obliged to hand out.
    expect(r.json().message).not.toContain('127.0.0.1')
  })

  // A refusal has to be more than a status code: the window bound exists to
  // stop a scan, so a bound checked after the query would be no bound at all.
  // Against a store that cannot answer, anything that reaches it is a 503 — so
  // a 400 here says the refusal came first, and the log says nothing was asked.
  it('refuses a window too long to read without reading anything', async () => {
    await onDeadWithLog(async (on, lines) => {
      const r = await on.inject({
        method: 'GET',
        url: '/api/reports/summary?from=2025-01-01T00:00:00.000Z&to=2026-09-25T00:00:00.000Z',
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('window_too_long')
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    })
  })

  // The credential is asked for route by route, with no hook over all of them,
  // and the 401 tests pin that each route asks — not where it asks. Moved below
  // the query, an unauthenticated request takes a report slot and scans the
  // window it chose before being told it was never allowed to ask, which is the
  // scan the credential is there to stop. Both routes, because each one asks
  // for its own and a rule one route knows is not inherited by its neighbour.
  it.each([
    ['the summary', `/api/reports/summary?${WINDOW}`],
    ['the chart', `/api/reports/timeseries?${WINDOW}&bucket=hour`],
  ])('refuses %s without a credential before reading anything', async (_label, url) => {
    await onDeadWithLog(async (on, lines) => {
      const r = await on.inject({ method: 'GET', url, headers: { host: ADMIN_HOST } })
      expect(r.statusCode).toBe(401)
      expect(r.json().error).toBe('unauthenticated')
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    })
  })

  // The same claim for the chart's own ceiling, and it needs making separately:
  // a hundred days is well inside the four hundred the window bound allows, so
  // the only thing that can refuse 2,400 hourly buckets is the bucket count. A
  // count taken after the query would be no ceiling at all — the scan it exists
  // to stop would already have happened — and against a store that cannot
  // answer, anything that reaches it is a 503, so the 400 is what says the
  // count came first.
  it('refuses too many buckets without reading anything', async () => {
    await onDeadWithLog(async (on, lines) => {
      const r = await on.inject({
        method: 'GET',
        url: '/api/reports/timeseries?from=2026-06-16T00:00:00.000Z&to=2026-09-24T00:00:00.000Z&bucket=hour',
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('too_many_buckets')
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    })
  })

  it('still answers everything that does not read it', async () => {
    const r = await deadApp.inject({ method: 'GET', url: '/api/links', headers: read(cookie) })
    expect(r.statusCode).toBe(200)
  })

  // The answer is the same 503 as an unreachable store, so the status alone
  // pins nothing: with no guard at all the query is attempted on nothing, the
  // TypeError is caught where a ClickHouse failure is caught, and the caller
  // sees the same body. The log is the difference, and it is the difference an
  // operator reads — so the log is what this asserts. **Do not turn this into
  // a status code**: answering the two cases differently would tell a caller
  // which of them it was, which is the one thing this surface set out not to
  // say, so the log line is the claim and the log line is what pins it.
  it('answers a report 503 when there is no client at all, and says which it was', async () => {
    const lines: string[] = []
    const none = testApp(pool, clock, {
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
      const r = await summary(none)
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('reporting_unavailable')
      expect(lines.filter((l) => l.includes('has no clickhouse client')).length).toBe(1)
      // And nothing was asked of a store that is not there.
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    } finally {
      await none.close()
    }
  })
})
