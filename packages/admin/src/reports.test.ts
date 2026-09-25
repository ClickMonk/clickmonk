import { ClickHouseLogLevel } from '@clickhouse/client'
import { ConcurrencyGate } from '@clickmonk/core'
import { type ClickHouseClient, createChClient } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AdminDeps } from './app.js'
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
    // Another visitor, another country, and a second value for five of the six
    // open dimensions a breakdown reads — every one but the target, which gets
    // its second value from the blocked click below, the one that reached none.
    // A fixture in which `device`, `os`, `browser` and `referrer` each held one
    // value could not tell a rollup that wrote the real column from one that
    // wrote a constant, and could not tell a breakdown that read the dimension
    // it was asked for from one that read some other.
    click({
      click_id: '01920000-0000-7000-8000-00000000000b',
      visitor_id: 'v2',
      country: 'US',
      device: 'tablet',
      os: 'android',
      browser: 'safari',
      referrer: 'https://news.example.com/other',
    }),
    // The same visitor as the first, on another link: one visitor, two clicks.
    click({ click_id: '01920000-0000-7000-8000-00000000000c', link_id: LINK_B, path: '/b' }),
    // A bot, blocked, in the same hour, by the same visitor as the first. It
    // reached no target, so its target id is empty — which is also the only
    // empty dimension value in these fixtures.
    //
    // Its device is a third value nobody else has, which is what gives the
    // device breakdown two values on one click each: the order of those two is
    // the tie-break and nothing else.
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
      device: 'mobile',
      os: 'android',
      browser: 'safari',
      referrer: 'https://news.example.com/other',
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
  // Link rows for the breakdown by link, which labels each id it counts. The
  // ids are the ones the clicks above carry; a third link exists and has no
  // clicks, and must not appear. No row is written for the zero id.
  await pool.query(
    `INSERT INTO domains (id, host, verified) VALUES ($1, 'go.example.test', true)`,
    [DOMAIN],
  )
  await pool.query(
    `INSERT INTO links (id, domain_id, slug, name) VALUES
       ($1, $3, 'spring', 'Spring offer'),
       ($2, $3, 'autumn', NULL),
       ('00000000-0000-4000-8000-0000000000a9', $3, 'unused', NULL)`,
    [LINK_A, LINK_B, DOMAIN],
  )
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
      // The whole install's newest hour, past the end of this window: the two
      // zero buckets above are quiet hours, and this is what says so.
      newestHour: '2026-09-25T00:00:00.000Z',
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
      newestHour: '2026-09-25T00:00:00.000Z',
    })
  })

  // The chart's own half-open end is the fill loop's, not the clause's. With
  // `at <= w.toMs` the loop draws a bucket for the instant the window ends at —
  // an empty one, because the clause returned no row for it — and two charts
  // drawn a day apart each show a bar for the same day.
  //
  // The clause's upper bound is a separate guard and this block does not cover
  // it: `< to` written as `<= to` leaves every chart test green, because the
  // extra group comes back and the fill loop never asks for it, and only the
  // summary catches it. The clause's lower bound the chart does cover — `>=
  // from` as `> from` fails this test and the per-link one. So an endpoint
  // added later that reuses `windowClause` inherits its upper bound from the
  // summary's tests and from nothing here.
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
      // Not narrowed by the link filter, any more than the summary's is.
      newestHour: '2026-09-25T00:00:00.000Z',
    })
  })

  // Days from noon UTC, which is midnight at UTC-12. The four clicks at ten
  // and the one at half past eleven on the 24th are in the day that began at
  // noon on the 23rd; the one at half past midnight on the 25th is in the day
  // that began at noon on the 24th. At offset zero the same request is three
  // UTC days, which is what the second assertion is for.
  it('counts days from where the offset puts midnight', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-23T12:00:00.000Z&to=2026-09-25T12:00:00.000Z&bucket=day&offset=-12',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: { from: '2026-09-23T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' },
      link: null,
      bucket: 'day',
      buckets: [
        { at: '2026-09-23T12:00:00.000Z', clicks: 5, visitors: 2 },
        { at: '2026-09-24T12:00:00.000Z', clicks: 1, visitors: 1 },
      ],
      newestHour: '2026-09-25T00:00:00.000Z',
    })
    const utc = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-23T12:00:00.000Z&to=2026-09-25T12:00:00.000Z&bucket=day',
      headers: read(cookie),
    })
    expect(utc.json().buckets).toHaveLength(3)
  })

  it('aligns a ragged window to the offset’s days, and says so', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/timeseries?from=2026-09-24T10:30:00.000Z&to=2026-09-24T11:30:00.000Z&bucket=day&offset=3',
      headers: read(cookie),
    })
    expect(r.json().window).toEqual({
      from: '2026-09-23T21:00:00.000Z',
      to: '2026-09-24T21:00:00.000Z',
    })
    expect(r.json().buckets).toEqual([{ at: '2026-09-23T21:00:00.000Z', clicks: 5, visitors: 2 }])
  })

  it('leaves an hour chart as it was, whatever the offset', async () => {
    const q = 'from=2026-09-24T10:00:00.000Z&to=2026-09-24T12:00:00.000Z&bucket=hour'
    const plain = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?${q}`,
      headers: read(cookie),
    })
    const moved = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?${q}&offset=5`,
      headers: read(cookie),
    })
    expect(moved.json()).toEqual(plain.json())
    expect(plain.json().buckets).toEqual([
      { at: '2026-09-24T10:00:00.000Z', clicks: 4, visitors: 2 },
      { at: '2026-09-24T11:00:00.000Z', clicks: 1, visitors: 1 },
    ])
  })

  it.each([
    ['an offset west of every zone', 'offset=-13'],
    ['an offset east of every zone', 'offset=15'],
    ['half an hour', 'offset=5.5'],
    ['something that is not a number', 'offset=east'],
  ])('refuses %s', async (_label, extra) => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?${WINDOW}&bucket=day&${extra}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
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
    // The window ends where the fixtures start: the earliest click is at 10:15
    // on the 24th and this stops at midnight that morning. So all hundred
    // buckets are zeroes the fill put there rather than rows the query left
    // out — which is exactly what a hundred quiet days look like too.
    expect(buckets.reduce((n, b) => n + b.clicks, 0)).toBe(0)
    // Which is what the freshness is for: the newest hour the install holds is
    // past the end of this window, so these hundred days are quiet and not
    // days nothing has been shipped for yet. The whole table, not the window.
    expect(r.json().newestHour).toBe('2026-09-25T00:00:00.000Z')
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
  //
  // The breakdown's own enum needs no such test: a dimension nobody has is a
  // 400 from the schema and, as a plain string, a query that reads no rows and
  // answers 200.
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

describe('GET /api/reports/breakdown', () => {
  const url = (extra: string) => `/api/reports/breakdown?${WINDOW}&${extra}`

  const breakdown = (extra: string, on: FastifyInstance = app) =>
    on.inject({ method: 'GET', url: url(extra), headers: read(cookie) })

  /** The window every whole-body assertion below echoes back. */
  const COUNTED = { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' }

  // Whole, and this is one of the four bodies asserted whole: `link`,
  // `dimension` and `truncated` are each echoed or derived, and each one is
  // asserted somewhere off the value it carries here — the keyed dimension
  // immediately below, the link further down, and the cut list after that. A
  // field only ever seen at its least interesting value can be replaced by a
  // constant.
  //
  // The click half an hour past the end of this window is what pins the
  // clause's upper bound here: counted, DE would be five clicks by two
  // visitors rather than four by one.
  it('breaks a window down by country, most clicks first', async () => {
    const r = await breakdown('dimension=country')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: COUNTED,
      link: null,
      dimension: 'country',
      truncated: false,
      rows: [
        // Four clicks by one visitor, which is the number no arithmetic over
        // the rows gives: the four are three rollup rows — two hours and two
        // links — and adding their visitor counts gives three.
        { value: 'DE', clicks: 4, visitors: 1 },
        { value: 'US', clicks: 1, visitors: 1 },
      ],
    })
  })

  // The other table, and whole for the `dimension` echo: a constant `'country'`
  // there answers the test above correctly and this one wrongly.
  it('breaks it down by a dimension that keys the hourly rollup instead', async () => {
    const r = await breakdown('dimension=class')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: COUNTED,
      link: null,
      dimension: 'class',
      truncated: false,
      rows: [
        // Two visitors over four clicks that are three rollup rows of one, two
        // and one visitor: summed they are four, merged they are two.
        { value: 'human', clicks: 4, visitors: 2 },
        { value: 'bot', clicks: 1, visitors: 1 },
      ],
    })
  })

  // Link A carries the first click, the second visitor's, the blocked bot's
  // and the one at half past eleven; link B the same visitor's click on it. The
  // unused link has no clicks and is not a row.
  it('breaks a window down by link, and names each link', async () => {
    const r = await breakdown('dimension=link')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: COUNTED,
      link: null,
      dimension: 'link',
      truncated: false,
      rows: [
        {
          value: LINK_A,
          clicks: 4,
          visitors: 2,
          link: { slug: 'spring', host: 'go.example.test', name: 'Spring offer' },
        },
        {
          value: LINK_B,
          clicks: 1,
          visitors: 1,
          link: { slug: 'autumn', host: 'go.example.test', name: null },
        },
      ],
    })
  })

  it('says a link it counted no longer exists, rather than dropping the row', async () => {
    await pool.query('DELETE FROM links WHERE id = $1', [LINK_B])
    try {
      const r = await breakdown('dimension=link')
      expect(r.json().rows[1]).toEqual({ value: LINK_B, clicks: 1, visitors: 1, link: null })
    } finally {
      await pool.query(
        `INSERT INTO links (id, domain_id, slug, name) VALUES ($1, $2, 'autumn', NULL)`,
        [LINK_B, DOMAIN],
      )
    }
  })

  it('carries no link field on any other dimension', async () => {
    const r = await breakdown('dimension=country')
    for (const row of r.json().rows)
      expect(Object.keys(row).sort()).toEqual(['clicks', 'value', 'visitors'])
  })

  it.each<[string, { value: string; clicks: number; visitors: number }[]]>([
    [
      'action',
      [
        { value: '', clicks: 4, visitors: 2 },
        { value: 'block', clicks: 1, visitors: 1 },
      ],
    ],
    [
      'outcome',
      [
        { value: 'target', clicks: 4, visitors: 2 },
        { value: 'blocked', clicks: 1, visitors: 1 },
      ],
    ],
    [
      'os',
      [
        { value: 'windows', clicks: 3, visitors: 1 },
        { value: 'android', clicks: 2, visitors: 2 },
      ],
    ],
    [
      'browser',
      [
        { value: 'chrome', clicks: 3, visitors: 1 },
        { value: 'safari', clicks: 2, visitors: 2 },
      ],
    ],
    [
      'referrer',
      [
        { value: 'blog.example.com', clicks: 3, visitors: 1 },
        { value: 'news.example.com', clicks: 2, visitors: 2 },
      ],
    ],
  ])('answers %s from whichever table holds it', async (dimension, rows) => {
    const r = await breakdown(`dimension=${dimension}`)
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toEqual(rows)
  })

  // The tie-break, which is the only thing that decides the last two rows here:
  // one click each, so ordered by clicks alone they come back in whatever order
  // the parts were read in, and a cut list would be arbitrary.
  it('breaks a tie between two values on the value, ascending', async () => {
    const r = await breakdown('dimension=device')
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toEqual([
      { value: 'desktop', clicks: 3, visitors: 1 },
      { value: 'mobile', clicks: 1, visitors: 1 },
      { value: 'tablet', clicks: 1, visitors: 1 },
    ])
  })

  // An empty value is a real answer — a click that reached no target — and is
  // shown as one rather than dropped, so the rows add up to the total beside
  // them.
  it('keeps an empty value rather than dropping it', async () => {
    const r = await breakdown('dimension=target')
    expect(r.json().rows).toEqual([
      { value: '00000000-0000-4000-8000-0000000000b1', clicks: 4, visitors: 2 },
      { value: '', clicks: 1, visitors: 1 },
    ])
  })

  // Both ends of the shared clause in one window, and the numbers rather than
  // the length: the hour this starts at holds a click, so `>= from` written as
  // `> from` empties the list, and the hour it ends at holds another by its own
  // visitor, so `< to` written as `<= to` doubles both numbers. The summary
  // catches an inclusive upper bound too — the chart is the one that cannot see
  // it — so what this adds is that the bound is pinned in this endpoint's own
  // window rather than inherited from another route's fixture.
  it('starts at the hour it names and stops before the hour it ends at', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/breakdown?from=2026-09-24T11:00:00.000Z&to=2026-09-25T00:00:00.000Z&dimension=country',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toEqual([{ value: 'DE', clicks: 1, visitors: 1 }])
  })

  it('counts whole hours and says which hours it counted', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/breakdown?from=2026-09-24T10:30:00.000Z&to=2026-09-24T11:10:00.000Z&dimension=country',
      headers: read(cookie),
    })
    // Asked for 10:30 to 11:10; counted 10:00 to 12:00, which is both hours.
    expect(r.json().window).toEqual({
      from: '2026-09-24T10:00:00.000Z',
      to: '2026-09-24T12:00:00.000Z',
    })
    // Unaligned, the four clicks at 10:15 fall outside their own window and
    // only the one at 11:30 is counted, so these numbers are the alignment.
    expect(r.json().rows).toEqual([
      { value: 'DE', clicks: 4, visitors: 1 },
      { value: 'US', clicks: 1, visitors: 1 },
    ])
  })

  // Whole, for the `link` echo: the bodies above carry `link: null`, which a
  // constant would answer too.
  it('counts one link when asked for one', async () => {
    const r = await breakdown(`dimension=country&link=${LINK_B}`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: COUNTED,
      link: LINK_B,
      dimension: 'country',
      truncated: false,
      rows: [{ value: 'DE', clicks: 1, visitors: 1 }],
    })
  })

  // Whole, for `truncated`: it is false in every other body asserted whole.
  it('cuts the list at the limit asked for and says it was cut', async () => {
    const r = await breakdown('dimension=country&limit=1')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      window: COUNTED,
      link: null,
      dimension: 'country',
      truncated: true,
      rows: [{ value: 'DE', clicks: 4, visitors: 1 }],
    })
  })

  // Away from one, where a cut and an off-by-one in either direction look
  // different: three values, two asked for. The row past the limit is read —
  // that is how `truncated` is known without a second query — and not shown.
  it('cuts a longer list at the limit too, and shows neither more nor fewer', async () => {
    const r = await breakdown('dimension=device&limit=2')
    expect(r.json().truncated).toBe(true)
    expect(r.json().rows).toEqual([
      { value: 'desktop', clicks: 3, visitors: 1 },
      { value: 'mobile', clicks: 1, visitors: 1 },
    ])
  })

  it('does not say it was cut when it was not', async () => {
    const r = await breakdown('dimension=country&limit=2')
    expect(r.json().truncated).toBe(false)
    expect(r.json().rows).toHaveLength(2)
  })

  // The ceiling itself, from both sides: the 500 is what says it is not one row
  // tighter than the number it promises, and the 501 that it is there at all.
  // Both written out rather than computed from MAX_BREAKDOWN_ROWS, since a bound
  // derived from the constant it is testing moves when the constant does and
  // goes on passing. What this window cannot say is that five hundred rows come
  // back when five hundred values exist — three values is all it holds — which
  // is what the block at the end of the file is for.
  it('takes the most rows it will return, and refuses one more', async () => {
    const at = await breakdown('dimension=country&limit=500')
    expect(at.statusCode).toBe(200)
    expect(at.json().truncated).toBe(false)
    const over = await breakdown('dimension=country&limit=501')
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toBe('invalid_query')
  })

  it.each([
    ['a dimension nobody has', 'dimension=asn'],
    ['no dimension at all', 'limit=10'],
    ['a limit of zero', 'dimension=country&limit=0'],
    ['a limit past the ceiling', 'dimension=country&limit=501'],
    ['a limit that is not a number', 'dimension=country&limit=all'],
    // Its own case, and the one the status code matters for: `all` does not
    // coerce to a number at all, but 2.5 does, and without `.int()` it reaches
    // ClickHouse as `LIMIT 3.5` and comes back as a 503 saying reporting is
    // unavailable on this install. That is the failure the link's shape was
    // moved into the parser to stop — a caller's own bad field reported to them
    // as an outage — so what this pins is the 400 and not the refusal.
    ['a limit that is not a whole number', 'dimension=country&limit=2.5'],
    ['a field nobody knows', 'dimension=country&order=value'],
  ])('refuses %s', async (_label, extra) => {
    const r = await breakdown(extra)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
  })

  // Its own, because the credential is asked for route by route with no hook
  // over all of them: a route that forgot to ask would read every click the
  // install has with the other two routes' 401 tests still green.
  it('needs a credential', async () => {
    const r = await app.inject({
      method: 'GET',
      url: url('dimension=country'),
      headers: { host: ADMIN_HOST },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
  })

  it('refuses when every report slot is taken', async () => {
    const other = testApp(pool, clock, { ch, reportGate: new ConcurrencyGate(0) })
    try {
      const r = await breakdown('dimension=country', other)
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_reports')
    } finally {
      await other.close()
    }
  })
})

/**
 * How many rows a breakdown returns, in a window of its own.
 *
 * Neither the default nor the ceiling can be read off the fixture above: no
 * dimension there holds more than three values, so any default of three or more
 * and any ceiling of three or more answers every assertion in it. Both numbers
 * need more values than they are, and more values than they are would move every
 * count in every other block — so this owns its own window, which is the rule a
 * per-window total follows.
 *
 * Its hour is in another month, so another partition, and it is older than the
 * newest hour the install holds, so the freshness the summary and the chart
 * assert does not move. No other window in this file reaches it: the hundred-day
 * chart starts on 2026-06-16, the two-thousand-bucket one on 2026-07-02, and the
 * window that would contain it is refused for being too long.
 */
describe('how many rows a breakdown returns', () => {
  const WINDOW_OF_ITS_OWN = 'from=2026-05-10T03:00:00.000Z&to=2026-05-10T04:00:00.000Z'

  /** One host per click, in ascending order, so the tie-break decides the list. */
  const host = (i: number): string => `h${String(i).padStart(3, '0')}.example.com`

  const rows = (query: string) =>
    app.inject({
      method: 'GET',
      url: `/api/reports/breakdown?${WINDOW_OF_ITS_OWN}&dimension=referrer&${query}`,
      headers: read(cookie),
    })

  beforeAll(async () => {
    // Five hundred and one values, one click each. A hundred and one would pin
    // the default and leave the ceiling where it is — read off a fixture too
    // small to reach it — so there are enough here to see five hundred rows come
    // back and a five hundred and first left behind.
    await insert(
      Array.from({ length: 501 }, (_, i) => {
        const n = String(i + 1).padStart(3, '0')
        return click({
          click_id: `01920000-0000-7000-8000-100000000${n}`,
          time: '2026-05-10 03:20:00.000',
          visitor_id: `m${n}`,
          referrer: `https://${host(i + 1)}/post`,
        })
      }),
    )
  })

  // A hundred written out, not taken from DEFAULT_BREAKDOWN_ROWS: a bound
  // derived from the constant it is testing moves when the constant does and
  // goes on passing. Ninety-nine and a hundred and one both fail this.
  it('returns a hundred rows when no limit is asked for, and says it cut the rest', async () => {
    const r = await rows('')
    expect(r.statusCode).toBe(200)
    expect(r.json().truncated).toBe(true)
    const got = r.json().rows as { value: string; clicks: number; visitors: number }[]
    expect(got).toHaveLength(100)
    // The top of the ordered list rather than a hundred of the five hundred and
    // one: every value has one click, so which hundred come back is the
    // tie-break and nothing else.
    expect(got[0]).toEqual({ value: 'h001.example.com', clicks: 1, visitors: 1 })
    expect(got[99]).toEqual({ value: 'h100.example.com', clicks: 1, visitors: 1 })
  })

  // The other half of the ceiling. That 500 is accepted and 501 refused is
  // pinned above; this is that five hundred rows actually come back when five
  // hundred values exist, which no window with three values in it can say.
  it('returns five hundred rows when five hundred are asked for', async () => {
    const r = await rows('limit=500')
    expect(r.statusCode).toBe(200)
    expect(r.json().truncated).toBe(true)
    const got = r.json().rows as { value: string; clicks: number; visitors: number }[]
    expect(got).toHaveLength(500)
    expect(got[499]).toEqual({ value: 'h500.example.com', clicks: 1, visitors: 1 })
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

  /**
   * The ends of the window against the ends of the type it is compared as.
   *
   * The length bound above does not imply a position bound: four hundred days in
   * the year 9999 is inside it, inside the bucket ceiling, and outside what
   * `DateTime64(3,'UTC')` can hold. What the store does with it is the reason
   * this is a refusal rather than a curiosity — below year 10000 it clamps
   * silently, so a report asked about 9999 is answered about 2299 with nothing
   * saying so, and above it the parameter is refused and the caller is told the
   * install is unavailable.
   *
   * Every instant is written out rather than taken from `MIN_STORE_MS` and
   * `MAX_STORE_MS`: a bound derived from the constant it is testing moves when
   * the constant moves and goes on passing.
   */
  it.each([
    ['the first instant the store holds', '1900-01-01T00:00:00.000Z', '1900-01-02T00:00:00.000Z'],
    ['the last', '2299-12-30T00:00:00.000Z', '2299-12-31T23:59:59.999Z'],
  ])('takes a window at %s', (_label, from, to) => {
    const w = parseWindow({ from, to }, { alignMs: null })
    expect(w.fromMs).toBe(Date.parse(from))
    expect(w.toMs).toBe(Date.parse(to))
  })

  it.each([
    // One millisecond before the first instant, and a day either side of the
    // last: the length of each is well inside four hundred days, which is the
    // half the length bound cannot see.
    [
      'a day before the first instant it holds',
      '1899-12-31T00:00:00.000Z',
      '1900-01-01T00:00:00.000Z',
    ],
    ['a day after its last', '2299-12-31T00:00:00.000Z', '2300-01-01T00:00:00.000Z'],
    ['a window in the year nine thousand', '9999-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z'],
  ])('refuses a window at %s', (_label, from, to) => {
    let thrown: unknown
    try {
      parseWindow({ from, to }, { alignMs: null })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(HttpError)
    expect((thrown as HttpError).status).toBe(400)
    expect((thrown as HttpError).code).toBe('invalid_query')
  })

  /**
   * Raising `to` to the next hour is itself a way past the end, which is why the
   * check runs on the aligned window and not on what the caller sent.
   *
   * This window is legal unaligned — both ends are inside the range, and it is
   * asserted here that they are — and illegal aligned, because the ceil to the
   * next hour lands in 2300 where the store clamps. One input, two answers, and
   * the only thing that decides is which side of the alignment the check sits on.
   * A window in the year 9999 could not pin that: it is outside the range before
   * the alignment as well, so a check in the wrong place refuses it too.
   */
  it('refuses a window the alignment pushes past the end, and takes it unaligned', () => {
    const q = { from: '2299-12-30T00:00:00.000Z', to: '2299-12-31T23:30:00.000Z' }
    expect(parseWindow(q, { alignMs: null }).toMs).toBe(Date.parse('2299-12-31T23:30:00.000Z'))
    let thrown: unknown
    try {
      parseWindow(q, { alignMs: HOUR_MS })
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

  it('aligns the start to the offset’s day even when UTC’s day has turned', () => {
    // 22:30 UTC on the 24th is 01:30 on the 25th at UTC+3, whose day began at
    // 21:00 UTC on the 24th. Floored without the offset it would be 21:00 UTC
    // on the 23rd.
    const w = parseWindow(
      { from: '2026-09-24T22:30:00.000Z', to: '2026-09-24T23:00:00.000Z' },
      { alignMs: 86_400_000, offsetMs: 3 * 3_600_000 },
    )
    expect(new Date(w.fromMs).toISOString()).toBe('2026-09-24T21:00:00.000Z')
    expect(new Date(w.toMs).toISOString()).toBe('2026-09-25T21:00:00.000Z')
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
   *
   * `reportGate` is for the guards that have to come before the queue as well as
   * before the query. A full gate and an unreachable store together give a
   * misplaced guard two different wrong answers — 429 from inside the gate, 503
   * from after the query — and one right one, so the caller's own status pins the
   * position rather than merely the presence.
   */
  const onDeadWithLog = async (
    fn: (on: FastifyInstance, lines: string[]) => Promise<void>,
    extra: Partial<AdminDeps> = {},
  ): Promise<void> => {
    const lines: string[] = []
    const on = testApp(pool, clock, {
      ch: dead,
      ...extra,
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
  // scan the credential is there to stop. Every route, because each one asks
  // for its own and a rule one route knows is not inherited by its neighbour.
  it.each([
    ['the summary', `/api/reports/summary?${WINDOW}`],
    ['the chart', `/api/reports/timeseries?${WINDOW}&bucket=hour`],
    ['a breakdown', `/api/reports/breakdown?${WINDOW}&dimension=country`],
  ])(
    'refuses %s without a credential before taking a slot or reading anything',
    async (_label, url) => {
      // The gate is full as well as the store unreachable, and that is the half
      // the 401 tests could not see. Asked for after the query, the credential
      // lets an unauthenticated request scan the window it chose — a 503 here.
      // Asked for inside the gate but before the query, it lets that request
      // take a report slot, so a flood of them answers the operator 429 without
      // a row being read — and every test in this file stayed green on that one
      // until this gate was put here. Only the position answers 401.
      await onDeadWithLog(
        async (on, lines) => {
          const r = await on.inject({ method: 'GET', url, headers: { host: ADMIN_HOST } })
          expect(r.statusCode).toBe(401)
          expect(r.json().error).toBe('unauthenticated')
          expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
        },
        { reportGate: new ConcurrencyGate(0) },
      )
    },
  )

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
