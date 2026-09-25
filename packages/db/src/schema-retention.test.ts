import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabases, testCh, testPg } from './testing.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

beforeEach(async () => {
  await pool.query('TRUNCATE settings')
  await pool.query('INSERT INTO settings DEFAULT VALUES')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

const set = (raw: number | null, ip: number | null) =>
  pool.query('UPDATE settings SET raw_retention_days = $1, ip_retention_days = $2', [raw, ip])

describe('postgres schema 007: retention', () => {
  it('defaults to ninety days of clicks and thirty of addresses', async () => {
    const r = await pool.query('SELECT raw_retention_days, ip_retention_days FROM settings')
    expect(r.rows).toEqual([{ raw_retention_days: 90, ip_retention_days: 30 }])
  })

  it('takes null for either, meaning for ever', async () => {
    await set(null, null)
    const r = await pool.query('SELECT raw_retention_days, ip_retention_days FROM settings')
    expect(r.rows).toEqual([{ raw_retention_days: null, ip_retention_days: null }])
  })

  it.each([
    ['zero clicks', 0, 30],
    ['zero days of addresses', 90, 0],
    ['a negative period', -1, 30],
    ['more than ten years', 3651, 30],
    ['more than ten years of addresses', 90, 3651],
  ])('refuses %s', async (_label, raw, ip) => {
    await expect(set(raw, ip)).rejects.toThrow(/settings_(raw|ip)_retention_valid/)
  })

  // The write gate for anything that bypasses the application is the CHECK,
  // not the schema in TypeScript: hand-written SQL reaches this row.
  it('accepts an IP period longer than the raw one rather than refusing it', async () => {
    await set(30, 90)
    const r = await pool.query('SELECT raw_retention_days, ip_retention_days FROM settings')
    expect(r.rows).toEqual([{ raw_retention_days: 30, ip_retention_days: 90 }])
  })
})
