import { createPgPool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkCap, tryConsumeCap } from './cap.js'

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

describe('checkCap', () => {
  const capped = async (slug: string) => {
    const d = await pool.query<{ id: string }>(
      "SELECT id FROM domains WHERE host = 'go.example.test'",
    )
    const l = await pool.query<{ id: string }>(
      'INSERT INTO links (domain_id, slug, click_cap) VALUES ($1, $2, 2) RETURNING id',
      [d.rows[0]?.id, slug],
    )
    return l.rows[0]?.id as string
  }
  const counter = async (id: string) =>
    (
      await pool.query<{ clicks: string }>('SELECT clicks FROM link_counters WHERE link_id = $1', [
        id,
      ])
    ).rows[0]?.clicks

  it('reads the counter and never writes it: ok under the cap, exhausted at it', async () => {
    const id = await capped('read')
    expect(await checkCap(pool, id, 2)).toBe('ok')
    // No counter row yet, and reading made none.
    expect(await counter(id)).toBeUndefined()
    await pool.query('INSERT INTO link_counters (link_id, clicks) VALUES ($1, 1)', [id])
    expect(await checkCap(pool, id, 2)).toBe('ok')
    await pool.query('UPDATE link_counters SET clicks = 2 WHERE link_id = $1', [id])
    expect(await checkCap(pool, id, 2)).toBe('exhausted')
    expect(await counter(id)).toBe('2')
  })

  it('reports unchecked, and does not reject, when Postgres cannot be reached', async () => {
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 150,
      queryTimeoutMs: 150,
    })
    await expect(checkCap(dead, linkId, 3)).resolves.toBe('unchecked')
    await dead.end()
  })

  // Its subject is the 150 ms bound itself, so it lets that timer fire.
  it('bounds the whole read, including the wait for a connection', async () => {
    const busy = createPgPool(TEST_PG_URL, { max: 1 })
    const held = await busy.connect()
    try {
      const start = Date.now()
      await expect(checkCap(busy, linkId, 3, 150)).resolves.toBe('unchecked')
      expect(Date.now() - start).toBeLessThan(400)
    } finally {
      held.release()
      await busy.end()
    }
  })
})
