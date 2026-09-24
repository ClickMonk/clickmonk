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
    const dim = await rows<{ name: string; type: string }>('DESCRIBE TABLE clicks_hourly_dim')
    expect(dim.map((c) => [c.name, c.type])).toEqual([
      ['hour', "DateTime('UTC')"],
      ['link_id', 'UUID'],
      ['domain_id', 'UUID'],
      ['dimension', 'LowCardinality(String)'],
      // A referrer host is whatever somebody linked from, so `value` is a plain
      // String: the dictionary a LowCardinality column keeps would grow without
      // a bound here, which is the same reason these six dimensions are rows
      // rather than keys of the table above.
      ['value', 'String'],
      ['clicks_state', 'AggregateFunction(uniqExact, UUID)'],
      ['visitors_state', 'AggregateFunction(uniqExact, String)'],
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
    // The three clicks above are the only ones in the file that override the
    // referrer. Two of them have no host — an empty string, and a value that is
    // not a URL, which `domain()` also reads as no host — and the third is a
    // second path on the default host. The five earlier clicks (the first
    // fixture, the second link, the bot, and the 404 pair) all keep the default
    // `https://blog.example.com/post`, so that host has those five plus this
    // test's third: six, against the two with none. Counted, not guessed —
    // this file's inserts accumulate and the arithmetic is easy to get
    // backwards.
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

/**
 * The rest of the file reads whatever has accumulated in the 10:00 hour. These
 * two use hours of their own instead, so they neither shift nor depend on the
 * running arithmetic above, and they run after the partition drop because a
 * rollup does not need the raw rows.
 *
 * Each inserts its clicks in ONE call, which is what makes these two
 * deterministic: a materialized view fires once per inserted block and
 * aggregates within it, and AggregatingMergeTree collapses equal sort keys as
 * it writes the part, so a column missing from the key shows up here without
 * waiting on a merge.
 *
 * That reaches only the columns one block can vary. Rows in two parts stay
 * apart until the parts are merged, whatever the key, so a column these
 * fixtures vary across insert calls is not tested here at all — which is what
 * the describe below forces with OPTIMIZE.
 */
describe('clickhouse schema 008: the key columns that keep rows apart', () => {
  const H11 = "toDateTime('2026-09-24 11:00:00', 'UTC')"
  const H12 = "toDateTime('2026-09-24 12:00:00', 'UTC')"

  /**
   * Class, action and outcome are keys rather than rows of the per-dimension
   * table, which only holds if each of them keeps rows apart on its own. Two of
   * these four clicks differ from a third only in their outcome, and two only
   * in their action, so dropping either column from the key merges a pair and
   * an arbitrary value wins.
   */
  it('keeps two clicks apart when they differ only in outcome, and only in action', async () => {
    await insert([
      click({ click_id: '01920000-0000-7000-8000-00000000003a', time: '2026-09-24 11:05:00.000' }),
      click({
        click_id: '01920000-0000-7000-8000-00000000003b',
        time: '2026-09-24 11:05:00.000',
        outcome: 'capped',
      }),
      click({
        click_id: '01920000-0000-7000-8000-00000000003c',
        time: '2026-09-24 11:05:00.000',
        traffic_class: 'bot',
        action: 'flag',
        signals: ['ua_bot'],
      }),
      click({
        click_id: '01920000-0000-7000-8000-00000000003d',
        time: '2026-09-24 11:05:00.000',
        traffic_class: 'bot',
        action: 'nothing',
        signals: ['ua_bot'],
      }),
    ])
    const byOutcome = await rows<{ outcome: string; clicks: string }>(
      `SELECT outcome, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE hour = ${H11} GROUP BY outcome ORDER BY outcome`,
    )
    expect(byOutcome).toEqual([
      { outcome: 'capped', clicks: '1' },
      { outcome: 'target', clicks: '3' },
    ])
    const byAction = await rows<{ action: string; clicks: string }>(
      `SELECT action, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE hour = ${H11} GROUP BY action ORDER BY action`,
    )
    expect(byAction).toEqual([
      { action: '', clicks: '2' },
      { action: 'flag', clicks: '1' },
      { action: 'nothing', clicks: '1' },
    ])
  })

  /**
   * The link is a key of the per-dimension table too, and every report that
   * breaks a single link down by country or device reads it that way. These two
   * clicks differ only in their link, so without the column in the key they
   * merge into one row under whichever link won.
   */
  it('keeps two clicks apart in the per-dimension rollup when they differ only in link', async () => {
    await insert([
      click({ click_id: '01920000-0000-7000-8000-00000000004a', time: '2026-09-24 12:05:00.000' }),
      click({
        click_id: '01920000-0000-7000-8000-00000000004b',
        time: '2026-09-24 12:05:00.000',
        link_id: LINK_B,
        path: '/b',
      }),
    ])
    const perLink = await rows<{ link_id: string; clicks: string }>(
      `SELECT link_id, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly_dim
         WHERE dimension = 'country' AND hour = ${H12} GROUP BY link_id ORDER BY link_id`,
    )
    expect(perLink).toEqual([
      { link_id: LINK_A, clicks: '1' },
      { link_id: LINK_B, clicks: '1' },
    ])
  })
})

/**
 * The sort keys themselves, which nothing above reaches: a column can be
 * missing from a key for as long as no two rows that differ only in it ever sit
 * in one part. `OPTIMIZE TABLE … FINAL` forces that merge, synchronously, and
 * against the committed schema it changes no number — so every expectation here
 * is the same before and after it.
 *
 * These clicks are in February rather than the September the rest of the file
 * accumulates in, because parts in different partitions never merge together:
 * the only rows the forced merge can collapse are the ones these tests wrote.
 * **That isolation is the monthly partition key**, so these tests depend on it
 * as much as on the sort key they are named for — which is why the first test
 * here pins the partition expression, rather than leaving a partition change to
 * surface as a sort-key test failing for a reason its name does not describe.
 */
describe('clickhouse schema 008: the sort keys, across a merge', () => {
  const FEB = 'toYYYYMM(hour) = 202602'

  /**
   * The expression, read from the engine, and not a row count that would follow
   * from it: a count can come out right under a different partitioning, and
   * whatever a rollup is partitioned by has to be derived from `hour` alone for
   * a report's window to read whole months rather than every part in the table.
   */
  it('partitions both rollup tables by the month of the hour', async () => {
    const keys = await rows<{ name: string; partition_key: string }>(
      `SELECT name, partition_key FROM system.tables
         WHERE database = currentDatabase() AND name IN ('clicks_hourly', 'clicks_hourly_dim')
         ORDER BY name`,
    )
    expect(keys).toEqual([
      { name: 'clicks_hourly', partition_key: 'toYYYYMM(hour)' },
      { name: 'clicks_hourly_dim', partition_key: 'toYYYYMM(hour)' },
    ])
  })

  /** A click that reached no target, from an address no database knew, with no referrer. */
  const nothingToShow = (clickId: string, time: string) =>
    click({
      click_id: clickId,
      time,
      outcome: 'blocked',
      step: 'traffic',
      status: 403,
      destination: '',
      target_id: '',
      country: '',
      referrer: '',
      traffic_class: 'bot',
      action: 'block',
      signals: ['ua_bot'],
    })

  const dimsAt = (hour: string) =>
    rows<{ dimension: string; value: string; clicks: string }>(
      `SELECT dimension, value, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly_dim
         WHERE hour = toDateTime('${hour}', 'UTC') GROUP BY dimension, value ORDER BY dimension`,
    )

  /**
   * What that one click must read as in every dimension. The value is asserted
   * and not only the dimension name: a view whose SELECT alias does not match a
   * target column is created without complaint and writes that column's
   * default, so a dimension can be present and empty for a reason that has
   * nothing to do with the click.
   */
  const ONE_CLICK_EVERY_DIMENSION = [
    { dimension: 'browser', value: 'chrome', clicks: '1' },
    { dimension: 'country', value: '', clicks: '1' },
    { dimension: 'device', value: 'desktop', clicks: '1' },
    { dimension: 'os', value: 'windows', clicks: '1' },
    { dimension: 'referrer', value: '', clicks: '1' },
    { dimension: 'target', value: '', clicks: '1' },
  ]

  /**
   * The hour, the link and the class: the three columns a report filters or
   * groups on before anything else. Each of these four clicks differs from the
   * first in exactly one of them, and each is inserted on its own so that no
   * two of them are ever in one part until the merge. The total is asserted
   * beside the breakdowns because that is the shape of the bug: a key column
   * missing from the table leaves the total right and destroys every breakdown
   * under it, so a report would answer 4 and then account for it wrongly.
   */
  it('keeps the hour, the link and the class apart when a merge collapses the parts', async () => {
    const base = { time: '2026-02-01 01:05:00.000', action: 'nothing' }
    await insert([click({ ...base, click_id: '01920000-0000-7000-8000-00000000005a' })])
    await insert([
      click({
        ...base,
        click_id: '01920000-0000-7000-8000-00000000005b',
        time: '2026-02-01 02:05:00.000',
      }),
    ])
    await insert([
      click({
        ...base,
        click_id: '01920000-0000-7000-8000-00000000005c',
        link_id: LINK_B,
        path: '/b',
      }),
    ])
    await insert([
      click({
        ...base,
        click_id: '01920000-0000-7000-8000-00000000005d',
        traffic_class: 'bot',
        signals: ['ua_bot'],
      }),
    ])
    await ch.command({ query: 'OPTIMIZE TABLE clicks_hourly FINAL' })

    // `AS at` rather than `AS hour`: an alias that repeats the column's name
    // shadows the column for the WHERE beside it, and this query would fail
    // with "Illegal type String of argument of function toYYYYMM" — the same
    // trap the state columns carry their `_state` suffix to avoid.
    const byHour = await rows<{ at: string; clicks: string }>(
      `SELECT toString(hour) AS at, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE ${FEB} GROUP BY hour ORDER BY hour`,
    )
    expect(byHour).toEqual([
      { at: '2026-02-01 01:00:00', clicks: '3' },
      { at: '2026-02-01 02:00:00', clicks: '1' },
    ])
    const byLink = await rows<{ link_id: string; clicks: string }>(
      `SELECT link_id, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE ${FEB} GROUP BY link_id ORDER BY link_id`,
    )
    expect(byLink).toEqual([
      { link_id: LINK_A, clicks: '3' },
      { link_id: LINK_B, clicks: '1' },
    ])
    const byClass = await rows<{ traffic_class: string; clicks: string }>(
      `SELECT traffic_class, uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly
         WHERE ${FEB} GROUP BY traffic_class ORDER BY traffic_class`,
    )
    expect(byClass).toEqual([
      { traffic_class: 'bot', clicks: '1' },
      { traffic_class: 'human', clicks: '3' },
    ])
    const feb = await rows<{ clicks: string }>(
      `SELECT uniqExactMerge(clicks_state) AS clicks FROM clicks_hourly WHERE ${FEB}`,
    )
    expect(feb).toEqual([{ clicks: '4' }])
  })

  /**
   * An empty value is a value, for each of the three dimensions that can hold
   * one. A view that filtered them out would leave a breakdown that no longer
   * adds up to the total beside it, and the click below is the one that has all
   * three at once.
   */
  it('keeps an empty country, referrer and target as values of their own', async () => {
    await insert([nothingToShow('01920000-0000-7000-8000-00000000006a', '2026-02-01 03:05:00.000')])
    expect(await dimsAt('2026-02-01 03:00:00')).toEqual(ONE_CLICK_EVERY_DIMENSION)
  })

  /**
   * And `dimension` is a key column, which the click above is also what proves:
   * its country, referrer and target rows share an hour, a link, a domain and
   * an empty value, so they differ in nothing else. Without `dimension` in the
   * key a merge folds the three into one and two of the six dimensions are
   * gone — not a blurred breakdown but a missing report.
   */
  it('keeps the six dimensions apart when three of them share an empty value', async () => {
    await insert([nothingToShow('01920000-0000-7000-8000-00000000007a', '2026-02-01 04:05:00.000')])
    await ch.command({ query: 'OPTIMIZE TABLE clicks_hourly_dim FINAL' })
    expect(await dimsAt('2026-02-01 04:00:00')).toEqual(ONE_CLICK_EVERY_DIMENSION)
  })
})
