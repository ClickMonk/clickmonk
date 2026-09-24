import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDatabases, testCh, testPg } from './testing.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

const LINK_A = '00000000-0000-4000-8000-0000000000a1'
const LINK_B = '00000000-0000-4000-8000-0000000000a2'
const DOMAIN = '00000000-0000-4000-8000-00000000000d'

/**
 * One click, as the shipper writes it. Fixture times are fixed rather than
 * relative to now on purpose: this file drops a partition, and a fixed month
 * is the only way the partition it drops is the one it inserted.
 */
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

async function rows<T>(query: string): Promise<T[]> {
  const rs = await ch.query({ query, format: 'JSONEachRow' })
  return rs.json<T>()
}

const totals = () =>
  rows<{ clicks: string; visitors: string }>(
    `SELECT uniqExactMerge(clicks_state) AS clicks, uniqExactMerge(visitors_state) AS visitors
       FROM clicks_hourly`,
  )

describe('clickhouse schema 008: the hourly rollups', () => {
  it('has the columns the reports read, with the states named so a query can alias its own output', async () => {
    const hourly = await rows<{ name: string; type: string }>('DESCRIBE TABLE clicks_hourly')
    expect(hourly.map((c) => [c.name, c.type])).toEqual([
      ['hour', "DateTime('UTC')"],
      ['link_id', 'UUID'],
      ['domain_id', 'UUID'],
      ['traffic_class', 'LowCardinality(String)'],
      ['action', 'LowCardinality(String)'],
      ['outcome', 'LowCardinality(String)'],
      ['clicks_state', 'AggregateFunction(uniqExact, UUID)'],
      ['visitors_state', 'AggregateFunction(uniqExact, String)'],
    ])
    const dim = await rows<{ name: string }>('DESCRIBE TABLE clicks_hourly_dim')
    expect(dim.map((c) => c.name)).toEqual([
      'hour',
      'link_id',
      'domain_id',
      'dimension',
      'value',
      'clicks_state',
      'visitors_state',
    ])
  })

  it('has one view per dimension and one for the hourly table', async () => {
    const views = await rows<{ name: string }>(
      "SELECT name FROM system.tables WHERE database = currentDatabase() AND engine = 'MaterializedView' ORDER BY name",
    )
    expect(views.map((v) => v.name)).toEqual([
      'clicks_hourly_browser_mv',
      'clicks_hourly_country_mv',
      'clicks_hourly_device_mv',
      'clicks_hourly_mv',
      'clicks_hourly_os_mv',
      'clicks_hourly_referrer_mv',
      'clicks_hourly_target_mv',
    ])
  })

  it('rolls a click up into the hour it happened in', async () => {
    await insert([click()])
    expect(await totals()).toEqual([{ clicks: '1', visitors: '1' }])
    const byHour = await rows<{ hour: string; clicks: string }>(
      'SELECT toString(hour) AS hour, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly GROUP BY hour ORDER BY hour',
    )
    expect(byHour).toEqual([{ hour: '2026-09-24 10:00:00', clicks: '1' }])
  })

  /**
   * The reason every measure is a set. The worker deletes a segment after
   * ClickHouse accepts it; a crash in between re-ships it byte for byte. With
   * a count() column this rollup would say two.
   */
  it('counts a segment shipped twice once', async () => {
    await insert([click()])
    expect(await totals()).toEqual([{ clicks: '1', visitors: '1' }])
    const raw = await rows<{ n: string }>('SELECT count() AS n FROM clicks')
    expect(raw).toEqual([{ n: '2' }])
  })

  it('counts one visitor on two links as one visitor for the install and one for each link', async () => {
    await insert([
      click({ click_id: '01920000-0000-7000-8000-00000000000b', link_id: LINK_B, path: '/b' }),
    ])
    expect(await totals()).toEqual([{ clicks: '2', visitors: '1' }])
    const perLink = await rows<{ link_id: string; clicks: string; visitors: string }>(
      `SELECT link_id, uniqExactMerge(clicks_state) AS clicks, uniqExactMerge(visitors_state) AS visitors
         FROM clicks_hourly GROUP BY link_id ORDER BY link_id`,
    )
    expect(perLink).toEqual([
      { link_id: LINK_A, clicks: '1', visitors: '1' },
      { link_id: LINK_B, clicks: '1', visitors: '1' },
    ])
  })

  it('counts one visitor with a human click and a bot click as one visitor', async () => {
    await insert([
      click({
        click_id: '01920000-0000-7000-8000-00000000000c',
        traffic_class: 'bot',
        action: 'flag',
        signals: ['ua_bot'],
      }),
    ])
    const byClass = await rows<{ traffic_class: string; clicks: string; visitors: string }>(
      `SELECT traffic_class, uniqExactMerge(clicks_state) AS clicks,
              uniqExactMerge(visitors_state) AS visitors
         FROM clicks_hourly GROUP BY traffic_class ORDER BY traffic_class`,
    )
    expect(byClass).toEqual([
      { traffic_class: 'bot', clicks: '1', visitors: '1' },
      { traffic_class: 'human', clicks: '2', visitors: '1' },
    ])
    expect(await totals()).toEqual([{ clicks: '3', visitors: '1' }])
  })

  it('separates two clicks on no link at all by the domain they asked for', async () => {
    const zero = '00000000-0000-0000-0000-000000000000'
    const other = '00000000-0000-4000-8000-00000000000e'
    await insert([
      click({
        click_id: '01920000-0000-7000-8000-00000000001a',
        link_id: zero,
        outcome: 'not_found',
        step: 'resolve',
        status: 404,
      }),
      click({
        click_id: '01920000-0000-7000-8000-00000000001b',
        link_id: zero,
        domain_id: other,
        outcome: 'not_found',
        step: 'resolve',
        status: 404,
      }),
    ])
    const byDomain = await rows<{ domain_id: string; clicks: string }>(
      `SELECT domain_id, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE link_id = toUUID('${zero}') GROUP BY domain_id ORDER BY domain_id`,
    )
    expect(byDomain).toEqual([
      { domain_id: DOMAIN, clicks: '1' },
      { domain_id: other, clicks: '1' },
    ])
  })

  it('keeps two clicks on no link at all apart by domain in the per-dimension rollup too', async () => {
    // The same pair the test above inserted, read from the other table: without
    // the domain in that table's key these two rows would merge and one
    // arbitrary domain would win, which is the defect the column exists for
    // even though no report reads it yet.
    const zero = '00000000-0000-0000-0000-000000000000'
    const other = '00000000-0000-4000-8000-00000000000e'
    const byDomain = await rows<{ domain_id: string; clicks: string }>(
      `SELECT domain_id, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly_dim
         WHERE dimension = 'country' AND link_id = toUUID('${zero}')
         GROUP BY domain_id ORDER BY domain_id`,
    )
    expect(byDomain).toEqual([
      { domain_id: DOMAIN, clicks: '1' },
      { domain_id: other, clicks: '1' },
    ])
  })

  it('rolls the referrer up by host, and an absent referrer as an empty host', async () => {
    await insert([
      click({ click_id: '01920000-0000-7000-8000-00000000002a', referrer: '' }),
      click({
        click_id: '01920000-0000-7000-8000-00000000002b',
        referrer: 'https://blog.example.com/other',
      }),
      click({ click_id: '01920000-0000-7000-8000-00000000002c', referrer: 'not a url' }),
    ])
    const byReferrer = await rows<{ value: string; clicks: string }>(
      `SELECT value, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly_dim
         WHERE dimension = 'referrer' GROUP BY value ORDER BY value`,
    )
    // These three are the only clicks in this file that override the referrer,
    // and two of the three have no host: an empty string, and a value that is
    // not a URL, which `domain()` also reads as no host. Every earlier click —
    // the first fixture, the second link, the bot, and the 404 pair — keeps
    // the default `https://blog.example.com/post`, which is six distinct
    // clicks with that host against two with none. Counted, not guessed: this
    // file's inserts accumulate, and the arithmetic is easy to get backwards.
    expect(byReferrer).toEqual([
      { value: '', clicks: '2' },
      { value: 'blog.example.com', clicks: '6' },
    ])
  })

  it('holds each open dimension as its own rows', async () => {
    const dims = await rows<{ dimension: string }>(
      'SELECT DISTINCT dimension FROM clicks_hourly_dim ORDER BY dimension',
    )
    expect(dims.map((d) => d.dimension)).toEqual([
      'browser',
      'country',
      'device',
      'os',
      'referrer',
      'target',
    ])
  })

  /**
   * The point of rollups outliving raw clicks, run against the engine rather
   * than asserted: the retention pass drops a raw partition and every number
   * a report shows is still there.
   */
  it('keeps every number when the raw partition is dropped', async () => {
    // Written out rather than read before and compared after: two reads of the
    // same query agree with each other when the views never fired and both
    // are empty, which is exactly the defect this test exists to catch. Eight
    // distinct click ids have been inserted by this point in the file — the
    // first fixture (twice, one id), the second link, the bot, the 404 pair
    // and the three referrer clicks — all by the one visitor the helper
    // defaults to.
    expect(await totals()).toEqual([{ clicks: '8', visitors: '1' }])
    await ch.command({ query: "ALTER TABLE clicks DROP PARTITION ID '202609'" })
    expect(await rows<{ n: string }>('SELECT count() AS n FROM clicks')).toEqual([{ n: '0' }])
    expect(await totals()).toEqual([{ clicks: '8', visitors: '1' }])
  })
})
