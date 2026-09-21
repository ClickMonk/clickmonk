import { afterAll, describe, expect, it } from 'vitest'
import { createPgPool } from './clients.js'
import { TEST_PG_URL, testPg } from './testing.js'

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
