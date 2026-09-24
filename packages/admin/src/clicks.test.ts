import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { ClickHouseLogLevel } from '@clickhouse/client'
import { ConcurrencyGate } from '@clickmonk/core'
import { type ClickHouseClient, createChClient } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CSV_FIELDS, type ClickRow, asClick } from './clicks.js'
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
 * Fifty-one clicks in one instant, in a month of its own. Older than every click
 * in the windows above, and newer than the one in the formula block below, which
 * is the oldest in the file.
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

/**
 * One click whose user agent opens the way a formula does, in a month of its own.
 *
 * A spreadsheet runs what the file hands it, not what the writer's helper
 * returned, so the defusing is read back off a streamed body and not only off
 * `csvCell`. A user agent is a string a stranger chose, which is what makes this
 * the field to do it with. Its own month, older than every other click in this
 * file, so no count and no page boundary above moves.
 */
const FORMULA_ID = '01920000-0000-7000-8000-000000000031'
const FORMULA_UA = '=HYPERLINK("https://example.com","click")'
const formulaClick = click({
  click_id: FORMULA_ID,
  time: '2026-07-10 10:00:00.000',
  user_agent: FORMULA_UA,
})

/** A well-formed id for a cursor whose instant is the thing under test. */
const CURSOR_ID = '01920000-0000-7000-8000-0000000000ff'

const WINDOW = 'from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z'

/** Two days nothing above reads: see the two blocks at the end of the file. */
const DAY_BEFORE = 'from=2026-09-23T00:00:00.000Z&to=2026-09-24T00:00:00.000Z'
const TIED_DAY = 'from=2026-09-22T00:00:00.000Z&to=2026-09-23T00:00:00.000Z'
const PAGE_DAY = 'from=2026-08-15T00:00:00.000Z&to=2026-08-16T00:00:00.000Z'
const FORMULA_DAY = 'from=2026-07-10T00:00:00.000Z&to=2026-07-11T00:00:00.000Z'

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
    // One in a month of its own, whose user agent a spreadsheet would run: see
    // the export's formula block at the end.
    formulaClick,
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
    // The bot click, whole: a list of signals joined into one cell, and seven
    // empty ones — the four this click had nothing in (destination, target,
    // country, geo source), the two no click carries yet (region, city), and the
    // network, because its address column was blanked.
    expect(out[1]).toBe(
      `"01920000-0000-7000-8000-000000000003","2026-09-24T10:02:00.000Z","go.example.test","/a","${DOMAIN}","${LINK_A}","blocked","classify","403","","","v1","false","","","","","desktop","windows","chrome","64500","bot","ua_bot head","block","https://blog.example.com/post","Mozilla/5.0 (Windows NT 10.0) Chrome/130","","true"`,
    )
    // The oldest click in this window, whole: the network the address was
    // truncated to, the instant as the JSON spells it, and a real value in every
    // column but four — region and city, which no click carries yet, and the
    // signals and action a click nothing was decided about has none of.
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
 * A gate that counts the slots it handed out and the times they were given back.
 *
 * The first count is so that a test about giving a slot back can say the export
 * took one: a case asserting an empty gate without it is a case an unserved
 * request satisfies. The second is because the release is called from three
 * places and the gate itself cannot tell — `leave()` on an empty gate does
 * nothing, so a release that ran twice is invisible in `inFlight` until two
 * exports run at once and one of them gives the other's slot away.
 */
class CountingGate extends ConcurrencyGate {
  entered = 0
  left = 0
  override tryEnter(): boolean {
    const ok = super.tryEnter()
    if (ok) this.entered++
    return ok
  }
  override leave(): void {
    this.left++
    super.leave()
  }
}

/**
 * A caller that hangs up, over a real socket.
 *
 * `inject` cannot ask this question: it has no socket to close, and the question
 * is what the server does when the peer goes away. `node:http` rather than
 * `fetch`, because the host guard reads the `Host` header and undici does not let
 * a caller set it.
 *
 * The timings are the ones that mattered: a hangup in the first few milliseconds
 * lands before the first row is pulled, which is the window where the generator's
 * `finally` never runs because the generator never started — and where, with one
 * export slot in the process, one request and an immediate close used to take the
 * endpoint out until a restart.
 */
describe('GET /api/clicks.csv, a caller that hangs up', () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * An export read to the end over a real socket, for the count rather than the
   * file.
   *
   * Three paths call the release — the generator's `finally` and the stream's
   * `close` and `error` — and an export that simply finishes takes two of them.
   * The gate cannot notice the second: `leave()` on an empty gate does nothing,
   * so a release that ran twice is invisible in `inFlight` until two exports run
   * at once and one of them hands back the other's slot. What is asserted is
   * therefore the number of calls.
   *
   * Over a socket and not through `inject`, which was measured calling it once:
   * `inject` has no connection to close, so the stream's `close` never reaches
   * this. An idempotence this file pinned through `inject` would be an assertion
   * about light-my-request.
   */
  it('gives the slot back exactly once when the export is read to the end', async () => {
    const gate = new CountingGate(1)
    const one = testApp(pool, clock, { ch, exportGate: gate })
    try {
      await one.listen({ host: '127.0.0.1', port: 0 })
      const at = one.server.address()
      const port = typeof at === 'object' && at !== null ? at.port : 0
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `/api/clicks.csv?${WINDOW}`,
            headers: { host: ADMIN_HOST, cookie },
          },
          (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              text += chunk
            })
            res.on('end', () => resolve(text))
          },
        )
        req.on('error', reject)
        req.end()
      })
      // The whole file came down the socket, which nothing else here checks:
      // every other export in this suite is read through `inject`.
      expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(4)
      await settle(100)
      expect(gate.entered).toBe(1)
      expect(gate.left).toBe(1)
      expect(gate.stats().inFlight).toBe(0)
    } finally {
      await one.close()
    }
  })

  /** Waits until the export holds the slot, so no case here is vacuous. */
  const untilEntered = async (gate: CountingGate): Promise<void> => {
    for (let waited = 0; waited < 2000; waited += 5) {
      if (gate.entered > 0) return
      await settle(5)
    }
    throw new Error('the export never took a slot, so this case would prove nothing')
  }

  it.each([0, 1, 2, 5, 10, 25])(
    'gives the slot back when the caller hangs up %ims after the export took it',
    async (ms) => {
      const gate = new CountingGate(1)
      const served = testApp(pool, clock, { ch, exportGate: gate })
      try {
        await served.listen({ host: '127.0.0.1', port: 0 })
        const at = served.server.address()
        const port = typeof at === 'object' && at !== null ? at.port : 0
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          path: `/api/clicks.csv?${WINDOW}`,
          headers: { host: ADMIN_HOST, cookie },
        })
        // The hangup is the arrangement, so the socket errors it causes are not a
        // failure of anything.
        req.on('error', () => {})
        req.end()
        await untilEntered(gate)
        await settle(ms)
        req.destroy()
        // Long enough for the server to notice the closed socket and destroy the
        // stream. A fixed wait rather than a poll: a loop that waited for the gate
        // to empty would pass whatever the release took, including never.
        await settle(250)
        expect(gate.entered).toBe(1)
        expect(gate.stats().inFlight).toBe(0)
        // And the consequence an operator would see: with a single slot, one
        // leaked slot answers every later export 429 until the process restarts.
        const again = await served.inject({
          method: 'GET',
          url: `/api/clicks.csv?${WINDOW}`,
          headers: read(cookie),
        })
        expect(again.statusCode).toBe(200)
      } finally {
        await served.close()
      }
    },
  )
})

/**
 * A value a spreadsheet would run, read back off the file.
 *
 * The unit tests for `csvCell` say the helper defuses one; this says the row the
 * export wrote did. They are different claims, and only the second one is about
 * the file an operator double-clicks. Its own window, so the fixture click is the
 * only row in it and the whole line can be asserted.
 */
describe('GET /api/clicks.csv, a value a spreadsheet would run', () => {
  it('defuses the cell and leaves the value readable in it', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${FORMULA_DAY}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    const out = r.body.split('\r\n').filter((l) => l.length > 0)
    expect(out).toHaveLength(2)
    // The whole row, written out: the apostrophe in front of the user agent, the
    // quotes inside it doubled, and every other cell where it belongs.
    expect(out[1]).toBe(
      `"${FORMULA_ID}","2026-07-10T10:00:00.000Z","go.example.test","/a","${DOMAIN}","${LINK_A}","target","destination","302","https://example.com/?c=01920000-0000-7000-8000-000000000001","${TARGET}","v1","false","DE","","","dbip","desktop","windows","chrome","64500","human","","","https://blog.example.com/post","'=HYPERLINK(""https://example.com"",""click"")","198.51.100.0/24","false"`,
    )
    // And said directly: no cell in the file opens with the formula. Asserted
    // after the line above, so an empty body could not satisfy it.
    expect(r.body).not.toContain('"=HYPERLINK')
  })
})

/**
 * The cap, where it is set.
 *
 * It reaches the query text as a `LIMIT`, so it is refused against the range it is
 * bound into and not only against its type — and refused when the app is built,
 * which is where a value from configuration arrives. Both ends, with literals,
 * for the reason every bound in this file is a literal: one derived from the
 * constant it is testing moves when the constant moves and goes on passing.
 */
describe('the export row cap, where it is set', () => {
  it.each([
    ['nothing to export', 0],
    ['a negative number of rows', -1],
    ['a fraction of a row', 2.5],
    ['more rows than a file holds', 10_000_001],
    ['not a number at all', Number.NaN],
  ])('refuses %s, when the app is built', (_label, cap) => {
    expect(() => testApp(pool, clock, { ch, exportRowCap: cap })).toThrow(/exportRowCap/)
  })

  it('takes the smallest cap there is, and exports one row', async () => {
    const small = testApp(pool, clock, { ch, exportRowCap: 1 })
    try {
      const r = await small.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(200)
      expect(r.headers['x-clickmonk-row-cap']).toBe('1')
      expect(r.headers['x-clickmonk-truncated']).toBe('true')
      expect(r.body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(2)
    } finally {
      await small.close()
    }
  })

  // The other end, and a request through it: the 200 is what says the store took
  // `LIMIT 10000000` rather than answering an error the caller would be told was
  // an install outage.
  it('takes the largest cap there is, and the store takes the query it makes', async () => {
    const large = testApp(pool, clock, { ch, exportRowCap: 10_000_000 })
    try {
      const r = await large.inject({
        method: 'GET',
        url: `/api/clicks.csv?${WINDOW}`,
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(200)
      expect(r.headers['x-clickmonk-row-cap']).toBe('10000000')
      expect(r.headers['x-clickmonk-truncated']).toBe('false')
      expect(r.body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(4)
    } finally {
      await large.close()
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

  /**
   * The same two rows through the file, which is cover rather than a second
   * check: the export maps with `asClick`, so it cannot answer differently
   * without the page answering differently too. It is here because this is the
   * surface where a wrong answer is a privacy incident, and because "it goes
   * through the same mapper" is a claim about the code that a test should not
   * have to take on trust.
   */
  it('exports the same two, as a network and as nothing', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/clicks.csv?${DAY_BEFORE}`,
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(200)
    const rows = r.body
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1)
    expect(rows).toHaveLength(2)
    // The id and the network of each, read as cells rather than as substrings of
    // the whole body: a `toContain` on `2001:db8:1234:5678::/64` would pass on a
    // file that had written it into the wrong row.
    expect(rows.map((l) => [l.slice(1, l.indexOf('","')), l.split(',').at(-2)])).toEqual([
      ['01920000-0000-7000-8000-000000000005', '""'],
      ['01920000-0000-7000-8000-000000000004', '"2001:db8:1234:5678::/64"'],
    ])
    // And the whole address neither of them may carry.
    expect(r.body).not.toContain('2001:db8:1234:5678:9abc:def0:1234:5678')
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
   * The export asks for the credential before it takes a slot, and this is what
   * pins it there rather than merely pinning that it asks at all.
   *
   * **Two positions on this route, not three.** The gate comes before the query
   * here, so an unauthenticated request whose credential check has been moved
   * anywhere below `tryEnter` is answered 429 by the full gate — after the probe
   * or before it, the answer is the same. Only asked for first is it 401. The
   * three-answer shape belongs to the report routes, where the query is inside
   * the gate; the numbers depend on the order a route actually has and are worth
   * measuring rather than copying.
   *
   * The query-failure line is asserted absent as well, because a status alone
   * cannot tell a refusal from a query that happened to fail.
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

  /**
   * The gate comes before the store read, and this is the case that says so.
   *
   * The same app as above and a credential this time: a full gate and an
   * unreachable store. Refused in front of the probe, the answer is 429 and
   * nothing was read; refused behind it, the probe fails first and the answer is
   * 503 with a query-failure line — which is a refused export that has already
   * scanned a window the caller chose, and a flood of them is a scan each. The
   * log line is what separates the two, because a 429 could also be a 429 that
   * happened after a successful read.
   */
  it('refuses a full gate before reading anything at all', async () => {
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
        headers: read(cookie),
      })
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_exports')
      expect(lines.filter((l) => l.includes('clickhouse query failed'))).toEqual([])
    } finally {
      await on.close()
    }
  })
})

/**
 * The file's columns against the mapper's fields.
 *
 * Two lists written in two places for one resource, so the failure to design
 * against is a field added to `asClick` — the next geo column, say — that the
 * export silently stops carrying. Nothing in the export's own tests can see that:
 * the header row and the values both come from `CSV_FIELDS`, so a file missing a
 * column is internally consistent and every assertion about it passes.
 *
 * The two sides come from different places, which is the point: the keys the
 * mapper actually returns, against the list the file is written from.
 */
describe('the export columns and the fields a click has', () => {
  it('names every field the log maps, and no others', () => {
    // The fixture row as `JSONEachRow` hands it over: the stored column names,
    // with `time` replaced by the millisecond form the column list selects. The
    // leftover `time` key is ignored by the mapper and by this comparison.
    const row = { ...click(), at_ms: '1758708000000' } as unknown as ClickRow
    expect([...CSV_FIELDS].sort()).toEqual(Object.keys(asClick(row)).sort())
  })
})

/**
 * A store that stops answering partway through a file.
 *
 * A stub client, because there is no way to ask a healthy ClickHouse to fail in
 * the middle of a result set — and the line under test is the only record an
 * operator ever gets that a file they downloaded is short. The stub answers the
 * probe, hands over one row, and then fails.
 */
describe('GET /api/clicks.csv, a store that fails mid-file', () => {
  const failingCh = (row: Record<string, unknown>): ClickHouseClient =>
    ({
      query: async ({ query }: { query: string }) =>
        query.includes('count()')
          ? { json: async () => [{ n: '1' }] }
          : {
              close: () => {},
              stream: () =>
                Readable.from(
                  (async function* () {
                    yield [{ json: () => row }]
                    throw new Error('the store stopped answering')
                  })(),
                  { objectMode: true },
                ),
            },
    }) as unknown as ClickHouseClient

  it('logs that the file is short, and gives the slot back', async () => {
    const lines: string[] = []
    const gate = new CountingGate(1)
    const on = testApp(pool, clock, {
      ch: failingCh({ ...click(), at_ms: '1758708000000' }),
      exportGate: gate,
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
      // The body is what a caller would be left holding, so a rejected inject is
      // as much of an answer as a resolved one: what is asserted is the log line
      // and the slot, which are what the server owes either way.
      await on
        .inject({ method: 'GET', url: `/api/clicks.csv?${WINDOW}`, headers: read(cookie) })
        .then(() => undefined)
        .catch(() => undefined)
      expect(gate.entered).toBe(1)
      expect(
        lines.filter((l) => l.includes('clickhouse failed while an export was streaming')),
      ).toHaveLength(1)
      expect(gate.stats().inFlight).toBe(0)
    } finally {
      await on.close()
    }
  })
})

/**
 * A caller reading while the store is still producing.
 *
 * **The property this endpoint was built for, and the one nothing here could
 * see.** The cap is a million rows, so an export that reads its answer to the end
 * before sending any of it holds a file's worth of memory in the process — which
 * is the whole reason the rows are streamed. Measured before this existed: an
 * implementation that concatenated every chunk and handed the result over as a
 * single-chunk stream passed all 398 tests of this service and the stack suite's
 * `content-length` assertion too, because a one-chunk stream is still chunked and
 * still carries no length. A length is a weaker question than this one.
 *
 * So the question asked here is the ordering: **were bytes given to the caller
 * while the store still had blocks to hand over?** No implementation that buffers
 * can answer yes, however it is written, and none that streams can answer no.
 *
 * A stub store, because a healthy ClickHouse hands over a small result set faster
 * than a socket can be read and the two events would not be ordered at all; and a
 * real socket, because `inject` resolves once with a whole body and has no
 * earlier moment to observe. The stub is what makes the ordering deterministic
 * rather than a race: it hands over one block and then **waits to be told the
 * caller has bytes**. A streaming server tells it within milliseconds. A
 * buffering one cannot, because it is itself waiting for the block, so the wait
 * expires, the file is produced whole, and the first bytes reach the caller with
 * every block already pulled.
 */
describe('GET /api/clicks.csv, a caller reading while the store produces', () => {
  /** Blocks the stub hands over. More than one, so "the last block" means something. */
  const BLOCKS = 8
  /**
   * How long the stub waits to hear that the caller has bytes before giving up and
   * producing the rest. Only ever paid by an implementation that cannot answer, so
   * it is the cost of a failure and not of a pass.
   */
  const WAIT_MS = 2000

  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  interface Producing {
    ch: ClickHouseClient
    /** How many blocks the store has been asked for so far. */
    pulled: () => number
    /** Told by the test the moment the caller is given its first bytes. */
    gotBytes: () => void
  }

  function producingCh(): Producing {
    let pulled = 0
    let tell = (): void => {}
    const bytesReached = new Promise<void>((resolve) => {
      tell = resolve
    })
    async function* blocks(): AsyncGenerator<{ json: () => ClickRow }[]> {
      for (let i = 0; i < BLOCKS; i++) {
        pulled++
        const row = {
          ...click(),
          click_id: `01920000-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`,
          at_ms: '1758708000000',
        } as unknown as ClickRow
        yield [{ json: () => row }]
        // The whole arrangement, in one line: after the first block the store will
        // not produce another until the caller has been given something.
        if (i === 0) await Promise.race([bytesReached, settle(WAIT_MS)])
      }
    }
    return {
      pulled: () => pulled,
      gotBytes: () => tell(),
      ch: {
        query: async ({ query }: { query: string }) =>
          query.includes('count()')
            ? { json: async () => [{ n: String(BLOCKS) }] }
            : { close: () => {}, stream: () => Readable.from(blocks(), { objectMode: true }) },
      } as unknown as ClickHouseClient,
    }
  }

  it('gives the caller bytes before the store has produced the last block', async () => {
    const store = producingCh()
    const served = testApp(pool, clock, { ch: store.ch })
    try {
      await served.listen({ host: '127.0.0.1', port: 0 })
      const at = served.server.address()
      const port = typeof at === 'object' && at !== null ? at.port : 0
      /** What the store had produced when the caller was first given bytes. */
      let pulledAtFirstBytes = -1
      let status = 0
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `/api/clicks.csv?${WINDOW}`,
            headers: { host: ADMIN_HOST, cookie },
          },
          (res) => {
            status = res.statusCode ?? 0
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              if (pulledAtFirstBytes === -1) {
                pulledAtFirstBytes = store.pulled()
                store.gotBytes()
              }
              text += chunk
            })
            res.on('end', () => resolve(text))
          },
        )
        req.on('error', reject)
        req.end()
      })
      // The whole file arrived, so none of this is about a request that failed
      // early: a refusal has no rows and would make the ordering below vacuous.
      expect(status).toBe(200)
      expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(BLOCKS + 1)
      // And the ordering. Not `-1`: that is "no chunk ever arrived", which the
      // length above already rules out and which would otherwise satisfy the
      // comparison that follows it.
      expect(pulledAtFirstBytes).not.toBe(-1)
      expect(pulledAtFirstBytes).toBeLessThan(BLOCKS)
    } finally {
      await served.close()
    }
  })
})

/**
 * A caller that takes the headers and then stops reading.
 *
 * This is the one hold in the service that nothing else bounds. A ClickHouse
 * query blocked writing into a socket nobody drains is not *executing*, so
 * `max_execution_time` never fires on it, the client's request timeout never
 * fires either, and Fastify's `connectionTimeout` is 0. Measured before the
 * deadline existed: the slot was still held after eighty seconds, and every
 * later export answered 429 until the stalled socket was destroyed. One leaked
 * key, one request.
 *
 * A real socket and a store with more rows than the buffers between here and the
 * kernel can hold: with the three-row fixture the whole file fits in one write
 * and finishes whether the caller reads it or not, which would make the case
 * vacuous.
 */
describe('GET /api/clicks.csv, a caller that stops reading', () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * A body of tens of megabytes, as a few rows carrying a long cell rather than
   * very many short ones.
   *
   * The size is what the case needs: measured, the buffers between the generator
   * and a paused reader — the stream's, Node's socket, and the kernel's windows on
   * loopback — swallowed two megabytes whole, so a body that size finished on its
   * own and proved nothing. The shape is what keeps it quick: a hundred thousand
   * one-row blocks through an object-mode stream took longer than the bytes did.
   */
  const ROWS = 4000
  const LONG_CELL = 'u'.repeat(8000)
  /** The deadline this app is built with, short enough to wait out in a test. */
  const DEADLINE_MS = 500

  /** A store that hands over `ROWS` rows, one block each, as fast as it is asked. */
  const bigCh = (): ClickHouseClient => {
    async function* blocks(): AsyncGenerator<{ json: () => ClickRow }[]> {
      for (let i = 0; i < ROWS; i++) {
        const row = {
          ...click(),
          click_id: `01920000-0000-7000-8000-${String(i).padStart(12, '0')}`,
          at_ms: '1758708000000',
          user_agent: LONG_CELL,
        } as unknown as ClickRow
        yield [{ json: () => row }]
      }
    }
    return {
      query: async ({ query }: { query: string }) =>
        query.includes('count()')
          ? { json: async () => [{ n: String(ROWS) }] }
          : { close: () => {}, stream: () => Readable.from(blocks(), { objectMode: true }) },
    } as unknown as ClickHouseClient
  }

  it('cuts the body off at the deadline, gives the slot back, and says so once', async () => {
    const gate = new CountingGate(1)
    const logged: string[] = []
    const served = testApp(pool, clock, {
      ch: bigCh(),
      exportGate: gate,
      exportDeadlineMs: DEADLINE_MS,
      log: {
        level: 'warn',
        stream: {
          write(line: string) {
            logged.push(line)
          },
        },
      },
    })
    try {
      await served.listen({ host: '127.0.0.1', port: 0 })
      const at = served.server.address()
      const port = typeof at === 'object' && at !== null ? at.port : 0
      let status = 0
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `/api/clicks.csv?${WINDOW}`,
          headers: { host: ADMIN_HOST, cookie },
        },
        (res) => {
          status = res.statusCode ?? 0
          // The whole arrangement: the headers are taken and the body is never
          // read. Nothing is resumed and nothing is destroyed.
          res.pause()
        },
      )
      // The server destroying the stream ends this request, which is not a
      // failure of anything here.
      req.on('error', () => {})
      req.end()
      // Waited for the headers rather than for the slot: the slot is taken before
      // the status line goes out, so a loop on the gate alone would reach the
      // assertion below before the caller had been answered at all.
      for (let waited = 0; waited < 5000 && status === 0; waited += 5) await settle(5)
      // The premise: the export took the slot and answered 200, so what follows
      // is about a body in flight rather than about a refusal.
      expect(status, 'the export was never answered').toBe(200)
      expect(gate.entered).toBe(1)

      // A fixed wait several times the deadline, not a poll: a loop that waited
      // for the gate to empty would pass whatever the release took, including
      // never — which is precisely the behaviour being fixed. Eighty seconds was
      // measured and was not the end of it.
      await settle(DEADLINE_MS * 6)
      expect(gate.stats().inFlight, 'the slot was still held past the deadline').toBe(0)
      // And the line, which is the only record an operator has: the 200 and every
      // header went out before the first row, so nothing about the answer can say
      // the file is short.
      expect(logged.filter((l) => l.includes('the caller stopped reading its body'))).toHaveLength(
        1,
      )

      // The consequence, end to end: with one export slot, a slot still held
      // answers every later export 429 for the life of the process. Over a socket
      // and drained, because this store's file is tens of megabytes and `inject`
      // would hold all of it as one string.
      const second = await new Promise<number>((resolve, reject) => {
        const other = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `/api/clicks.csv?${WINDOW}`,
            headers: { host: ADMIN_HOST, cookie },
          },
          (res) => {
            res.on('data', () => {})
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        other.on('error', reject)
        other.end()
      })
      expect(second).toBe(200)
    } finally {
      await served.close()
    }
  })
})
