import { ClickHouseLogLevel } from '@clickhouse/client'
import { afterAll, describe, expect, it } from 'vitest'
import { createChClient, createPgPool } from './clients.js'
import { TEST_CH, TEST_PG_URL, testPg } from './testing.js'

const admin = testPg()

afterAll(async () => {
  await admin.end()
})

describe('createPgPool', () => {
  it('survives an idle connection being killed, and serves the next query', async () => {
    const errors: unknown[] = []
    const pool = createPgPool(TEST_PG_URL, { max: 1, onError: (err) => errors.push(err) })
    try {
      const client = await pool.connect()
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      client.release()
      // The connection is now idle in the pool. Kill it from another session.
      await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid])
      const end = Date.now() + 3000
      while (errors.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
      expect(errors).toHaveLength(1)
      const next = await pool.query<{ one: number }>('SELECT 1 AS one')
      expect(next.rows[0]?.one).toBe(1)
    } finally {
      await pool.end()
    }
  })
})

describe('createChClient', () => {
  /**
   * What the bound does, not what it is spelled. The library ignores an option
   * name it does not know without a word — `requestTimeout` for
   * `request_timeout` reads as a configured bound and is none — so the check
   * is a query that outlives the bound and has to come back as a failure
   * rather than as an answer. The ceiling is well under the query's own length
   * and unrelated to the timeout, so it cannot pass by arithmetic.
   */
  it('gives up on a query that outlives the timeout it was given', async () => {
    const ch = createChClient({
      ...TEST_CH,
      requestTimeoutMs: 300,
      logLevel: ClickHouseLogLevel.OFF,
    })
    const started = Date.now()
    try {
      await expect(ch.query({ query: 'SELECT sleep(3)', format: 'JSONEachRow' })).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await ch.close()
    }
  })

  it('leaves a query alone when it is given no timeout at all', async () => {
    const ch = createChClient({ ...TEST_CH, logLevel: ClickHouseLogLevel.OFF })
    try {
      const rs = await ch.query({ query: 'SELECT sleep(1) AS slept', format: 'JSONEachRow' })
      expect((await rs.json<{ slept: number }>()).length).toBe(1)
    } finally {
      await ch.close()
    }
  })
})
