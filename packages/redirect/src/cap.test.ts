import { createPgPool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tryConsumeCap } from './cap.js'

const pool = testPg()
const ch = testCh()
let linkId: string

beforeAll(async () => {
  await resetDatabases(pool, ch)
  const d = await pool.query<{ id: string }>(
    "INSERT INTO domains (host, verified) VALUES ('go.example.test', true) RETURNING id",
  )
  const l = await pool.query<{ id: string }>(
    "INSERT INTO links (domain_id, slug, click_cap) VALUES ($1, 'capped', 3) RETURNING id",
    [d.rows[0]?.id],
  )
  linkId = l.rows[0]?.id as string
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

describe('tryConsumeCap', () => {
  it('allows exactly `cap` clicks, even when they arrive together', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tryConsumeCap(pool, linkId, 3)),
    )
    expect(results.filter((r) => r === 'ok')).toHaveLength(3)
    expect(results.filter((r) => r === 'exhausted')).toHaveLength(7)
    const c = await pool.query<{ clicks: string }>(
      'SELECT clicks FROM link_counters WHERE link_id = $1',
      [linkId],
    )
    expect(Number(c.rows[0]?.clicks)).toBe(3)
  })

  it('reports unchecked, and does not reject, when Postgres cannot be reached', async () => {
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 150,
      queryTimeoutMs: 150,
    })
    await expect(tryConsumeCap(dead, linkId, 3)).resolves.toBe('unchecked')
    await dead.end()
  })

  it('bounds the whole call, including the wait for a connection', async () => {
    // The pool's only connection is held, so the call cannot even start its
    // query. Without the bound it would wait until the connection came back.
    const busy = createPgPool(TEST_PG_URL, { max: 1 })
    const held = await busy.connect()
    try {
      const start = Date.now()
      await expect(tryConsumeCap(busy, linkId, 3, 150)).resolves.toBe('unchecked')
      expect(Date.now() - start).toBeLessThan(400)
    } finally {
      held.release()
      await busy.end()
    }
  })
})
