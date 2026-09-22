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

// DateTime64(3) text, relative to now like every fixture time.
const NOW = new Date().toISOString().replace('T', ' ').replace('Z', '')

const row = (clickId: string) => ({
  click_id: clickId,
  time: NOW,
  host: 'go.example.test',
  path: '/spring',
  domain_id: '00000000-0000-4000-8000-00000000000d',
  link_id: '00000000-0000-4000-8000-0000000000a1',
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/',
  target_id: '',
  visitor_id: 'v1',
  returning: 0,
  country: '',
  region: '',
  city: '',
  geo_source: '',
  device: 'desktop',
  user_agent: 'test',
  referrer: '',
  ip: '192.0.2.1',
  cap_unchecked: 0,
  traffic_class: 'bot',
  signals: ['ua_bot', 'rate'],
  action: 'flag',
  os: 'windows',
  browser: 'chrome',
  asn: 64500,
})

describe('clickhouse clicks table', () => {
  it('has the columns the shipper writes, including the city-ready location', async () => {
    const rs = await ch.query({ query: 'DESCRIBE TABLE clicks', format: 'JSONEachRow' })
    const cols = (await rs.json<{ name: string }>()).map((c) => c.name)
    expect(cols).toEqual(Object.keys(row('x')))
  })

  // This documents the counting rule on the real engine; it guards no
  // product code. Merges are stopped so a background merge cannot collapse
  // the two rows before the query and make `rows` read 1.
  it('counts a click delivered twice once, by click_id', async () => {
    const id = '01920000-0000-7000-8000-00000000abcd'
    await ch.command({ query: 'SYSTEM STOP MERGES clicks' })
    try {
      await ch.insert({ table: 'clicks', values: [row(id)], format: 'JSONEachRow' })
      await ch.insert({ table: 'clicks', values: [row(id)], format: 'JSONEachRow' })
      const rs = await ch.query({
        query: 'SELECT count() AS rows, uniqExact(click_id) AS clicks FROM clicks',
        format: 'JSONEachRow',
      })
      const [r] = await rs.json<{ rows: string; clicks: string }>()
      expect(Number(r?.rows)).toBe(2)
      expect(Number(r?.clicks)).toBe(1)
    } finally {
      await ch.command({ query: 'SYSTEM START MERGES clicks' })
    }
  })

  it('gives a click written without classification empty values, not human', async () => {
    const id = '01920000-0000-7000-8000-00000000abce'
    const { traffic_class, signals, action, os, browser, asn, ...older } = row(id)
    await ch.insert({ table: 'clicks', values: [older], format: 'JSONEachRow' })
    const rs = await ch.query({
      query:
        'SELECT traffic_class, signals, action, os, browser, asn FROM clicks WHERE click_id = {id:UUID}',
      query_params: { id },
      format: 'JSONEachRow',
    })
    expect(await rs.json()).toEqual([
      { traffic_class: '', signals: [], action: '', os: '', browser: '', asn: 0 },
    ])
  })

  it('stores the largest ASN there is', async () => {
    const id = '01920000-0000-7000-8000-00000000abcf'
    await ch.insert({
      table: 'clicks',
      values: [{ ...row(id), asn: 4294967295 }],
      format: 'JSONEachRow',
    })
    const rs = await ch.query({
      query: 'SELECT asn FROM clicks WHERE click_id = {id:UUID}',
      query_params: { id },
      format: 'JSONEachRow',
    })
    expect(await rs.json()).toEqual([{ asn: 4294967295 }])
  })
})
