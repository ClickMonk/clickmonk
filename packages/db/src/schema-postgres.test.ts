import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from './testing.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

async function insertDomain(host = 'go.example.test'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'INSERT INTO domains (host, verified) VALUES ($1, true) RETURNING id',
    [host],
  )
  return r.rows[0]?.id as string
}

describe('postgres schema 001', () => {
  it('stores a domain, a link and its targets', async () => {
    const d = await insertDomain()
    const l = await pool.query<{ id: string; passthrough: boolean; countries: unknown }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'spring') RETURNING id, passthrough, countries",
      [d],
    )
    expect(l.rows[0]?.passthrough).toBe(true)
    expect(l.rows[0]?.countries).toEqual({ mode: 'all' })
    await pool.query(
      "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/', 100, 0)",
      [l.rows[0]?.id],
    )
  })

  it('rejects an upper-case or empty host', async () => {
    await expect(
      pool.query("INSERT INTO domains (host) VALUES ('Go.Example.test')"),
    ).rejects.toThrow()
    await expect(pool.query("INSERT INTO domains (host) VALUES ('')")).rejects.toThrow()
  })

  it('makes a slug unique per domain, and case-sensitive', async () => {
    const d = await insertDomain('b.example.test')
    await pool.query("INSERT INTO links (domain_id, slug) VALUES ($1, 'x')", [d])
    await expect(
      pool.query("INSERT INTO links (domain_id, slug) VALUES ($1, 'x')", [d]),
    ).rejects.toThrow()
    await pool.query("INSERT INTO links (domain_id, slug) VALUES ($1, 'X')", [d])
  })

  it('bounds weights and caps', async () => {
    const d = await insertDomain('c.example.test')
    await expect(
      pool.query("INSERT INTO links (domain_id, slug, click_cap) VALUES ($1, 'z', 0)", [d]),
    ).rejects.toThrow()
    const l = await pool.query<{ id: string }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'w') RETURNING id",
      [d],
    )
    await expect(
      pool.query(
        "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/', 0, 0)",
        [l.rows[0]?.id],
      ),
    ).rejects.toThrow()
  })

  it('cascades a domain delete to its links, targets and counters', async () => {
    const d = await insertDomain('d.example.test')
    const l = await pool.query<{ id: string }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'q') RETURNING id",
      [d],
    )
    const id = l.rows[0]?.id
    await pool.query('INSERT INTO link_counters (link_id, clicks) VALUES ($1, 3)', [id])
    await pool.query('DELETE FROM domains WHERE id = $1', [d])
    const left = await pool.query('SELECT 1 FROM link_counters WHERE link_id = $1', [id])
    expect(left.rowCount).toBe(0)
  })

  it.each(['domains', 'links', 'link_targets'])(
    'notifies config_changed when %s changes',
    async (table) => {
      const listener = new pg.Client({ connectionString: TEST_PG_URL })
      await listener.connect()
      const got: string[] = []
      listener.on('notification', (n) => got.push(`${n.channel}:${n.payload}`))
      await listener.query('LISTEN config_changed')
      try {
        await pool.query(`DELETE FROM ${table} WHERE false`)
        // A statement trigger fires even when no row matched.
        await new Promise((r) => setTimeout(r, 200))
        expect(got).toContain(`config_changed:${table}`)
      } finally {
        await listener.end()
      }
    },
  )
})
