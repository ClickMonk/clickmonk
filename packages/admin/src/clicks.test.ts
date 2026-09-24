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
const DOMAIN_B = '00000000-0000-4000-8000-00000000000e'
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

/**
 * `optimize_on_insert: 0`, so that a click written twice stays two rows.
 *
 * On by default, the engine collapses equal sort keys as it writes each part,
 * which happens *before* any merge: a re-shipped click inside one INSERT would
 * be one row by the time the first test ran, and `FINAL` would have nothing to
 * deduplicate. With it off the pair is held in one part, with no merge to race
 * and nothing set on the server that another suite on these shared databases
 * could inherit.
 */
const insert = (values: Record<string, unknown>[]) =>
  ch.insert({
    table: 'clicks',
    values,
    format: 'JSONEachRow',
    clickhouse_settings: { optimize_on_insert: 0 },
  })

/**
 * Six clicks on one day, in three instants: three of them share a millisecond,
 * two share another, one is alone. Ids ascend with the order they are written
 * in, so that the order a page must come back in is the reverse of this list.
 *
 * A fixture in which no two clicks share an instant cannot see the difference
 * between a boundary on the pair the order is by and a boundary on the time
 * alone — and the second of those silently drops every row of a tie after the
 * first, which is the one thing a log must never do.
 */
const TIED_IDS = [
  '01920000-0000-7000-8000-000000000011',
  '01920000-0000-7000-8000-000000000012',
  '01920000-0000-7000-8000-000000000013',
  '01920000-0000-7000-8000-000000000014',
  '01920000-0000-7000-8000-000000000015',
  '01920000-0000-7000-8000-000000000016',
]
const TIED_TIMES = [
  '2026-09-22 10:00:00.000',
  '2026-09-22 10:00:00.000',
  '2026-09-22 10:00:00.000',
  '2026-09-22 10:01:00.000',
  '2026-09-22 10:01:00.000',
  '2026-09-22 10:02:00.000',
]
const tied = TIED_IDS.map((id, i) => click({ click_id: id, time: TIED_TIMES[i] }))

/**
 * Fifty-one clicks in one instant, in a month of its own and older than every
 * other click in this file.
 *
 * The page size a caller gets when they name none cannot be read off a window of
 * three or six clicks: any default of three or more answers every assertion in
 * them. So this window holds one more click than the default, in a partition of
 * its own so that it moves nothing else, and all fifty-one share an instant — a
 * page of them is then cut by the id alone, which is the tie-break, so the same
 * window says what the default is and which fifty it returns.
 */
const PAGE_INSTANT = '2026-08-15 10:00:00.000'
const PAGE_INSTANT_MS = Date.parse('2026-08-15T10:00:00.000Z')
const PAGE_IDS = Array.from(
  { length: 51 },
  (_, i) => `01920000-0000-7000-8000-0000000002${(i + 1).toString(16).padStart(2, '0')}`,
)
const manyInOneInstant = PAGE_IDS.map((id) => click({ click_id: id, time: PAGE_INSTANT }))

/** A well-formed id for a cursor whose instant is the thing under test. */
const CURSOR_ID = '01920000-0000-7000-8000-0000000000ff'

const WINDOW = 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'

/** Two days nothing above reads: see the two blocks at the end of the file. */
const DAY_BEFORE = 'from=2026-09-23T00:00:00.000Z&to=2026-09-24T00:00:00.000Z'
const TIED_DAY = 'from=2026-09-22T00:00:00.000Z&to=2026-09-23T00:00:00.000Z'
const PAGE_DAY = 'from=2026-08-15T00:00:00.000Z&to=2026-08-16T00:00:00.000Z'

beforeAll(async () => {
  await resetDatabases(pool, ch)
  await insert([
    click(),
    // The same click again: one segment, shipped twice, and two rows because of
    // the insert setting above.
    click(),
    // Every field this row overrides is a field the first row also has, and a
    // second value is the only thing that can tell a response reading the column
    // from a response carrying a constant. Six of them — the host, the domain,
    // the device, the OS, the browser and the user agent — had one value across
    // the whole fixture, and the user agent is the most identifying thing in a
    // click after the visitor id.
    click({
      click_id: '01920000-0000-7000-8000-000000000002',
      time: '2026-09-24 10:01:00.000',
      host: 'links.example.test',
      domain_id: DOMAIN_B,
      link_id: LINK_B,
      path: '/b',
      country: 'US',
      visitor_id: 'v2',
      returning: 1,
      ip: '2001:db8:1234:5678:9abc:def0:1234:5678',
      referrer: '',
      asn: 0,
      device: 'ios',
      os: 'ios',
      browser: 'safari',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605',
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
    // Two addresses the parser reads differently, a day earlier so that they are
    // outside every window above: another row inside the day would move every
    // count and every page boundary the first block asserts.
    //
    // The redirect writes a canonical bare address and refuses nothing, so what
    // this column may hold is whatever shipped the record — a plain String
    // bounded only in length. The bracketed form with a port is a network once
    // the port is taken off; the zone-suffixed form is not an address at all and
    // can be stored today, since nothing on the write path would reject it.
    click({
      click_id: '01920000-0000-7000-8000-000000000004',
      time: '2026-09-23 10:00:00.000',
      ip: '[2001:db8:1234:5678:9abc:def0:1234:5678]:443',
    }),
    click({
      click_id: '01920000-0000-7000-8000-000000000005',
      time: '2026-09-23 10:01:00.000',
      ip: '2001:db8:1234:5678:9abc:def0:1234:5678%eth0',
    }),
    // Six clicks two days earlier, three of them in one millisecond and two in
    // another: see the paging block at the end of the file.
    ...tied,
    // Fifty-one in another month: see the default-page block at the end.
    ...manyInOneInstant,
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
   * The raw count is read first, and it is what says the pair was still two rows
   * when the log was read — so that this test is about `FINAL` and not about a
   * fixture that had already been deduplicated behind it. What holds it there is
   * `optimize_on_insert: 0` on the fixture's INSERT, not luck.
   */
  it('shows a click that was shipped twice once', async () => {
    const rs = await ch.query({
      query: `SELECT count() AS n FROM clicks WHERE click_id = '01920000-0000-7000-8000-000000000001'`,
      format: 'JSONEachRow',
    })
    expect(
      await rs.json(),
      'the re-shipped copy is no longer a second row, so this test cannot see whether FINAL deduplicated anything and would pass either way. The fixture holds the pair with optimize_on_insert: 0 on its INSERT; if that has gone, or a merge rewrote the part, restore it there. Not SYSTEM STOP MERGES, which these shared test databases would hand to every other suite.',
    ).toEqual([{ n: '2' }])
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
   *
   * It is also where six columns of the click itself are read at their second
   * value — the host, the domain, the device, the OS, the browser and the user
   * agent — which is what makes them columns rather than constants this mapper
   * could have written in. The other whole click, in the test above, carries the
   * first value of each.
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
          host: 'links.example.test',
          path: '/b',
          domainId: DOMAIN_B,
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
          device: 'ios',
          os: 'ios',
          browser: 'safari',
          asn: null,
          class: 'human',
          signals: [],
          action: null,
          referrer: null,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605',
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
    // Three instants no click can have, and all three used to reach the store.
    // The first is one millisecond past what `DateTime64(3,'UTC')` represents,
    // which ClickHouse does not refuse but silently clamps to 2299 — so the
    // caller would be paged from an instant they never named. The second is the
    // start of year 10000, where `toISOString` switches to its extended-year
    // form and the text this module builds is not a timestamp at all: a 503 and
    // an error-level query-failure line, after a report slot was taken, for a
    // bad request. The third is the largest the pattern's digits allow.
    ['a cursor one millisecond past the last instant', `cursor=10413792000000.${CURSOR_ID}`],
    ['a cursor in year ten thousand', `cursor=253402300800000.${CURSOR_ID}`],
    ['a cursor of nothing but nines', `cursor=999999999999999.${CURSOR_ID}`],
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

  /**
   * The newest instant a cursor may name, one millisecond below the refusal
   * above. Written out rather than read from `MAX_CURSOR_MS`, because a bound
   * derived from the constant it is testing moves when the constant moves and
   * goes on passing — and this end is the one that says the check is not a
   * millisecond tighter than the type it protects.
   *
   * It reads every click in the window, since every click is older than it:
   * the 200 is what says the store accepted the instant rather than refusing or
   * clamping it.
   */
  it('takes the last instant a click can have', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&cursor=10413791999999.${CURSOR_ID}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().clicks).toHaveLength(3)
  })

  // The ceiling from both sides. The 200 is what says it is not one row tighter
  // than the number it promises — tightening it to 150 passed every other test
  // in this file — and the 201 that it is there at all. Both literals, for the
  // reason the cursor's last instant is a literal.
  it('takes the largest page it will return, and refuses one more', async () => {
    const at = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&limit=200`,
      headers: read(cookie),
    })
    expect(at.statusCode).toBe(200)
    expect(at.json().nextCursor).toBeNull()
    const over = await app.inject({
      method: 'GET',
      url: `/api/clicks?${WINDOW}&limit=201`,
      headers: read(cookie),
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toBe('invalid_query')
  })

  // The window the store cannot hold, refused by this route because the parser
  // every report route shares refuses it. Four hundred days in 9999 is inside
  // the length bound, and the store would clamp it to 2299 and answer for a year
  // nobody asked about — the refusal is what keeps the window this response
  // echoes the window that was read.
  it('refuses a window the store could not hold', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/clicks?from=9999-01-01T00:00:00.000Z&to=9999-12-31T00:00:00.000Z',
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
 * The same log, as a file.
 *
 * Every data row is asserted whole where the fixture gives it an interesting
 * value, rather than by a substring: the header row and the values come from one
 * list, so a column dropped from it changes both — and what a substring could
 * not see is a value written into the wrong column, or a cell that stopped being
 * quoted. The two rows read whole are the bot click, which carries a list, four
 * empty columns and no network, and the oldest click, which carries a value in
 * every column but two.
 */
describe('GET /api/clicks.csv', () => {
  const lines = (body: string): string[] => body.split('\r\n').filter((l) => l.length > 0)

  /**
   * The first cell of every data row. Not a `toContain` on the whole body for an
   * id: the base fixture click's `destination` carries its own click id, so a
   * body holding the second click also holds the first click's id and an
   * absent-id assertion would pass against an export that had not dropped it.
   */
  const idsOf = (body: string): string[] =>
    lines(body)
      .slice(1)
      .map((l) => l.slice(1, l.indexOf('","')))

  const HEADER =
    '"clickId","at","host","path","domainId","linkId","outcome","step","status","destination","targetId","visitorId","returning","country","region","city","geoSource","device","os","browser","asn","class","signals","action","referrer","userAgent","network","capUnchecked"'

  it('exports the rows the log would have listed, newest first, as a file', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="clicks-20260924T000000Z-20260925T000000Z.csv"',
    )
    expect(r.headers['x-clickmonk-truncated']).toBe('false')
    expect(r.headers['x-clickmonk-row-cap']).toBe('1000000')
    const out = lines(r.body)
    expect(out[0]).toBe(HEADER)
    expect(out).toHaveLength(4)
    expect(idsOf(r.body)).toEqual([
      '01920000-0000-7000-8000-000000000003',
      '01920000-0000-7000-8000-000000000002',
      '01920000-0000-7000-8000-000000000001',
    ])
    // The bot click, whole: a list of signals joined into one cell, four columns
    // that are empty because the click had nothing in them, and no network
    // because its address column was blanked.
    expect(out[1]).toBe(
      `"01920000-0000-7000-8000-000000000003","2026-09-24T10:02:00.000Z","go.example.test","/a","${DOMAIN}","${LINK_A}","blocked","classify","403","","","v1","false","","","","","desktop","windows","chrome","64500","bot","ua_bot head","block","https://blog.example.com/post","Mozilla/5.0 (Windows NT 10.0) Chrome/130","","true"`,
    )
    // The oldest click, whole: the network the address was truncated to, the
    // instant as the JSON spells it, and every other column at a real value.
    expect(out[3]).toBe(
      `"01920000-0000-7000-8000-000000000001","2026-09-24T10:00:00.000Z","go.example.test","/a","${DOMAIN}","${LINK_A}","target","destination","302","https://example.com/?c=01920000-0000-7000-8000-000000000001","${TARGET}","v1","false","DE","","","dbip","desktop","windows","chrome","64500","human","","","https://blog.example.com/post","Mozilla/5.0 (Windows NT 10.0) Chrome/130","198.51.100.0/24","false"`,
    )
  })

  /**
   * The re-shipped pair is still two rows in the table, asserted first for the
   * reason the log's own dedup test asserts it: without that, a fixture a merge
   * had already collapsed would pass this whether the export says FINAL or not.
   */
  it('writes a click that was shipped twice once', async () => {
    const rs = await ch.query({
      query: `SELECT count() AS n FROM clicks WHERE click_id = '01920000-0000-7000-8000-000000000001'`,
      format: 'JSONEachRow',
    })
    expect(
      await rs.json(),
      'the re-shipped copy is no longer a second row, so this test would pass whether or not the export deduplicates. The fixture holds the pair with optimize_on_insert: 0 on its INSERT.',
    ).toEqual([{ n: '2' }])
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}`,
      headers: read(cookie),
    })
    expect(
      idsOf(r.body).filter((id) => id === '01920000-0000-7000-8000-000000000001'),
    ).toHaveLength(1)
  })

  it('holds nothing: no content-length, and a chunked body', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}`,
      headers: read(cookie),
    })
    expect(r.headers['content-length']).toBeUndefined()
    expect(r.headers['transfer-encoding']).toBe('chunked')
  })

  it('says in a header when the window held more than the cap, and stops at the cap', async () => {
    const capped = testApp(pool, clock, { ch, exportRowCap: 2 })
    try {
      const r = await capped.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.headers['x-clickmonk-truncated']).toBe('true')
      expect(r.headers['x-clickmonk-row-cap']).toBe('2')
      // A header row and the two newest clicks; the third is not there.
      expect(lines(r.body)).toHaveLength(3)
      expect(idsOf(r.body)).toEqual([
        '01920000-0000-7000-8000-000000000003',
        '01920000-0000-7000-8000-000000000002',
      ])
    } finally {
      await capped.close()
    }
  })

  it('does not claim truncation when the window held exactly the cap', async () => {
    const capped = testApp(pool, clock, { ch, exportRowCap: 3 })
    try {
      const r = await capped.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.headers['x-clickmonk-truncated']).toBe('false')
      expect(lines(r.body)).toHaveLength(4)
    } finally {
      await capped.close()
    }
  })

  it('takes the same filters as the log', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}&class=bot`,
      headers: read(cookie),
    })
    expect(lines(r.body)).toHaveLength(2)
    expect(idsOf(r.body)).toEqual(['01920000-0000-7000-8000-000000000003'])
  })

  it.each([
    ['a class nobody has', 'class=spider'],
    ['a field nobody knows', 'limit=10'],
    [
      'a cursor, which an export does not take',
      'cursor=1758708000000.01920000-0000-7000-8000-000000000001',
    ],
  ])('refuses %s, before a single byte is written', async (_label, extra) => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}&${extra}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
    // No file began: a query parsed after the headers were set answers a 400
    // that a browser saves as a download.
    expect(r.headers['content-type']).toMatch(/application\/json/)
    expect(r.headers['content-disposition']).toBeUndefined()
  })

  it('needs a credential, and writes no bytes of a file', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${WINDOW}`,
      headers: { host: ADMIN_HOST },
    })
    expect(r.statusCode).toBe(401)
    // A refusal that had already started the body would be a 401 with CSV in
    // it, which is what a guard moved below the stream looks like.
    expect(r.headers['content-type']).toMatch(/application\/json/)
    expect(r.body).not.toContain('"clickId"')
  })

  it('gives the export slot back when the stream has ended', async () => {
    const one = new ConcurrencyGate(1)
    const shared = testApp(pool, clock, { ch, exportGate: one })
    try {
      const first = await shared.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(first.statusCode).toBe(200)
      // The first export has finished, so the slot is back and the second is not
      // refused. A slot given back when the handler returned would make this
      // pass while bounding nothing, which is why the refusal below is the test
      // that pins the gate.
      const second = await shared.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(second.statusCode).toBe(200)
      expect(one.stats().inFlight).toBe(0)
    } finally {
      await shared.close()
    }
  })

  it('refuses when the export slot is taken', async () => {
    const full = testApp(pool, clock, { ch, exportGate: new ConcurrencyGate(0) })
    try {
      const r = await full.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_exports')
      expect(r.headers['retry-after']).toBe('1')
      // And no file began: the refusal is in front of the query, not in front
      // of the last row.
      expect(r.headers['content-type']).toMatch(/application\/json/)
      expect(r.body).not.toContain('"clickId"')
    } finally {
      await full.close()
    }
  })

  it('uses the report gate for nothing, so an export does not lock out a dashboard', async () => {
    const busy = testApp(pool, clock, { ch, reportGate: new ConcurrencyGate(0) })
    try {
      const r = await busy.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(200)
    } finally {
      await busy.close()
    }
  })
})

/**
 * Two addresses the parser reads differently, in a window of their own.
 *
 * `truncateIp` answers null for anything that is not bare address text, so the
 * stored value goes through `addressOnly` first: without that, a bracketed
 * address with a port reads as "no network" — the answer a click whose address
 * the retention pass blanked gets, which is the one thing the two must not
 * share.
 *
 * The zone-suffixed form is the other half, and it stays null on purpose. There
 * is no parse this module could do that would turn `%eth0` into a network, so
 * what the operator is told is the truth: this click has no network. What a null
 * therefore means is one of two things — the column was blanked, or whatever
 * wrote the row was not this redirect — and nothing in the response distinguishes
 * them, because nothing in the row does either.
 */
describe('GET /api/clicks, addresses a proxy may have spelled oddly', () => {
  it('shows the bracketed one as a network and the zone-suffixed one as nothing', async () => {
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
    ).toEqual([
      ['01920000-0000-7000-8000-000000000005', null],
      ['01920000-0000-7000-8000-000000000004', '2001:db8:1234:5678::/64'],
    ])
  })
})

/**
 * Paging across a tie, one click at a time.
 *
 * The boundary is on `(time, click_id)` because the order is on `(time,
 * click_id)`, and the pair is the whole point: with a boundary on the time
 * alone, the next page starts after the *instant* the last row had, so every
 * other row sharing that instant is skipped. Six clicks in three instants, three
 * of them tied and two of them tied, walked at one row a page: the wrong
 * boundary returns three of the six and every assertion about a page's length
 * still passes, which is why this walks the whole window and compares ids.
 *
 * Its own window, because six more clicks in the window above would move every
 * count and every page boundary asserted there.
 */
describe('GET /api/clicks, paging across a tie', () => {
  const idsOf = (r: { json: () => { clicks: { clickId: string }[] } }): string[] =>
    r.json().clicks.map((c) => c.clickId)

  it('walks every click exactly once, newest first', async () => {
    const seen: string[] = []
    let url = `/api/clicks?${TIED_DAY}&limit=1`
    // One request per click plus the one that ends it, and a hard stop well
    // inside that: a loop whose bound is the thing it is testing would spin for
    // ever on a cursor that does not advance.
    for (let page = 0; page < 10; page++) {
      const r = await app.inject({ method: 'GET', url, headers: read(cookie) })
      expect(r.statusCode).toBe(200)
      seen.push(...idsOf(r))
      const next = r.json().nextCursor as string | null
      if (next === null) break
      url = `/api/clicks?${TIED_DAY}&limit=1&cursor=${encodeURIComponent(next)}`
    }
    // Newest first, and within one instant by descending id: the reverse of the
    // order the fixture writes them in.
    expect(seen).toEqual([...TIED_IDS].reverse())
  })

  // The same six in one page: nothing is lost when no cursor is given. What the
  // page size actually is belongs to the block below, which owns a window big
  // enough to read it off.
  it('returns them all when no page size is asked for', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${TIED_DAY}`,
      headers: read(cookie),
    })
    expect(idsOf(r)).toEqual([...TIED_IDS].reverse())
    expect(r.json().nextCursor).toBeNull()
  })
})

/**
 * The page a caller gets when they ask for no page size.
 *
 * Fifty of fifty-one, and the fifty it returns are the fifty highest ids: with
 * every click at one instant the order is the id alone, so a cut at the wrong end
 * — an ascending tie-break — returns a different fifty and not a different
 * number, which no assertion about the length could see. The one left out is
 * named, and the cursor is asserted whole, so the page ends where the next one
 * starts.
 *
 * Fifty is written out rather than read from `DEFAULT_CLICK_PAGE`, for the reason
 * every bound in this file is written out.
 */
describe('GET /api/clicks, the page size nobody asked for', () => {
  it('answers fifty of them, newest id first, and says there are more', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks?${PAGE_DAY}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    const ids = r.json().clicks.map((c: { clickId: string }) => c.clickId)
    expect(ids).toHaveLength(50)
    // The fifty highest ids, descending: everything but the lowest.
    expect(ids).toEqual([...PAGE_IDS].slice(1).reverse())
    expect(ids).not.toContain(PAGE_IDS[0])
    // And the boundary is the last row of this page, not the end of the window.
    expect(r.json().nextCursor).toBe(`${PAGE_INSTANT_MS}.${PAGE_IDS[1]}`)
  })
})

describe('the log and the export when ClickHouse is not there', () => {
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

  /**
   * The export answers the same 503, and gives its slot back, so a store that is
   * down does not read as a queue that is full.
   *
   * Two requests in a row through the same app, whose export gate holds one
   * slot: the probe fails inside the gate, and the slot is given back by the
   * handler's own `finally` because the generator never took ownership of it.
   * Without that `finally` the second request is a 429 about an export nobody is
   * running.
   */
  it('answers 503 for an export and does not keep the slot it took', async () => {
    const on = testApp(pool, clock, { ch: dead })
    try {
      const first = await on.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(first.statusCode).toBe(503)
      expect(first.json().error).toBe('reporting_unavailable')
      // No file began, and no header of one: the probe runs before any of them
      // is set.
      expect(first.headers['content-type']).toMatch(/application\/json/)
      expect(first.headers['content-disposition']).toBeUndefined()
      const second = await on.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(second.statusCode).toBe(503)
      expect(second.json().error).toBe('reporting_unavailable')
    } finally {
      await on.close()
    }
  })

  /**
   * The export asks for the credential before it takes a slot and before it
   * reads anything, and this is what pins it there.
   *
   * Three positions, three answers, and the 401 beside the other export tests
   * can only see the first of them. With the export gate full and the store
   * unreachable: asked for after the probe, an unauthenticated request scans the
   * window it chose and gets a 503; asked for inside the gate but before the
   * probe, it gets a 429; only asked for before both is the answer 401. The
   * query-failure line is asserted absent as well, because a status alone cannot
   * tell a refusal from a query that happened to fail.
   */
  it('refuses an export without a credential before taking a slot or reading anything', async () => {
    const lines: string[] = []
    const on = testApp(pool, clock, {
      ch: dead,
      exportGate: new ConcurrencyGate(0),
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
        url: `/api/clicks.csv?${WINDOW}`,
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
