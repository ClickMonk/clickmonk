import { randomUUID } from 'node:crypto'
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
})

type ConfigTable = 'domains' | 'links' | 'link_targets' | 'settings'
type ConfigEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'

const CONFIG_TABLES: ConfigTable[] = ['domains', 'links', 'link_targets', 'settings']
const CONFIG_EVENTS: ConfigEvent[] = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']

// A column every row already has, self-assigned: the UPDATE below never
// matches a row (WHERE false), so the SET clause is never evaluated and no
// CHECK constraint runs — this only needs a column name to be syntactically
// valid.
const TOUCH_COLUMN: Record<ConfigTable, string> = {
  domains: 'verified',
  links: 'enabled',
  link_targets: 'weight',
  settings: 'abuser_threshold',
}

// Postgres refuses to TRUNCATE a table that something else still has a
// foreign key into, unless every such table is truncated in the same
// statement (or CASCADE is used, which would also empty tables the case
// under test never touches). link_counters has no config_changed trigger of
// its own but must be listed here because it references links.
const TRUNCATE_STATEMENT: Record<ConfigTable, string> = {
  domains: 'TRUNCATE domains, domain_dns_checks, links, link_targets, link_counters',
  links: 'TRUNCATE links, link_targets, link_counters',
  link_targets: 'TRUNCATE link_targets',
  settings: 'TRUNCATE settings',
}

async function ensureDomainForNotify(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'INSERT INTO domains (host) VALUES ($1) RETURNING id',
    [`notify-${randomUUID()}.example.test`],
  )
  return r.rows[0]?.id as string
}

async function ensureLinkForNotify(): Promise<string> {
  const domainId = await ensureDomainForNotify()
  const r = await pool.query<{ id: string }>(
    'INSERT INTO links (domain_id, slug) VALUES ($1, $2) RETURNING id',
    [domainId, `notify-${randomUUID()}`],
  )
  return r.rows[0]?.id as string
}

// INSERT is the only event that needs a row: an UPDATE or DELETE with a
// false predicate, and a TRUNCATE, fire the statement-level trigger
// regardless of whether any row exists or matches (see "notifies
// config_changed" below).
async function insertRowFor(table: ConfigTable): Promise<void> {
  if (table === 'settings') {
    // One row at most; the statement trigger fires whether or not it inserts.
    await pool.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    return
  }
  if (table === 'domains') {
    await pool.query('INSERT INTO domains (host) VALUES ($1)', [
      `notify-${randomUUID()}.example.test`,
    ])
    return
  }
  if (table === 'links') {
    const domainId = await ensureDomainForNotify()
    await pool.query('INSERT INTO links (domain_id, slug) VALUES ($1, $2)', [
      domainId,
      `notify-${randomUUID()}`,
    ])
    return
  }
  const linkId = await ensureLinkForNotify()
  await pool.query(
    "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/', 1, 0)",
    [linkId],
  )
}

async function fireConfigEvent(table: ConfigTable, event: ConfigEvent): Promise<void> {
  switch (event) {
    case 'INSERT':
      await insertRowFor(table)
      return
    case 'UPDATE':
      await pool.query(
        `UPDATE ${table} SET ${TOUCH_COLUMN[table]} = ${TOUCH_COLUMN[table]} WHERE false`,
      )
      return
    case 'DELETE':
      await pool.query(`DELETE FROM ${table} WHERE false`)
      return
    case 'TRUNCATE':
      await pool.query(TRUNCATE_STATEMENT[table])
      return
  }
}

describe('config_changed notifications', () => {
  it.each(CONFIG_TABLES.flatMap((table) => CONFIG_EVENTS.map((event) => [table, event] as const)))(
    'notifies config_changed when %s receives %s',
    async (table, event) => {
      const listener = new pg.Client({ connectionString: TEST_PG_URL })
      await listener.connect()
      const got: string[] = []
      listener.on('notification', (n) => got.push(`${n.channel}:${n.payload}`))
      await listener.query('LISTEN config_changed')
      try {
        await fireConfigEvent(table, event)
        const expected = `config_changed:${table}`
        // A statement trigger fires even when no row matched, but the
        // notification still arrives asynchronously.
        const end = Date.now() + 3000
        while (!got.includes(expected) && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 25))
        }
        expect(got).toContain(expected)
      } finally {
        await listener.end()
      }
    },
  )
})

describe('postgres schema 005', () => {
  it('gives every domain a token of the right shape without being told one, and a different one each time', async () => {
    const a = await pool.query<{ verification_token: string }>(
      "INSERT INTO domains (host) VALUES ('token-a.example.test') RETURNING verification_token",
    )
    const b = await pool.query<{ verification_token: string }>(
      "INSERT INTO domains (host) VALUES ('token-b.example.test') RETURNING verification_token",
    )
    expect(a.rows[0]?.verification_token).toMatch(/^[0-9a-f]{32}$/)
    expect(b.rows[0]?.verification_token).toMatch(/^[0-9a-f]{32}$/)
    expect(a.rows[0]?.verification_token).not.toBe(b.rows[0]?.verification_token)
  })

  it('refuses a token an outsider could guess', async () => {
    // The host is a fixed lower-case name rather than one derived from the
    // token: derived, the upper-case case would break the host CHECK first
    // and the row would be refused for the wrong reason. The constraint is
    // named in the assertion for the same reason.
    const bad = ['', 'not-hex', 'A'.repeat(32), '0'.repeat(31)]
    for (const [i, token] of bad.entries()) {
      await expect(
        pool.query('INSERT INTO domains (host, verification_token) VALUES ($1, $2)', [
          `bad-${i}.example.test`,
          token,
        ]),
      ).rejects.toThrow(/domains_verification_token_valid/)
    }
  })

  it('allows at most one check per domain', async () => {
    // A fresh domain_id, so this rejection is the primary key's, not a
    // status or detail CHECK reachable only after the first row exists.
    const d = await insertDomain('checks-pk.example.test')
    await pool.query(
      "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'verified', 'ok')",
      [d],
    )
    await expect(
      pool.query(
        "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'error', 'x')",
        [d],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "domain_dns_checks_pkey"/)
  })

  it('refuses a status outside the enum', async () => {
    const d = await insertDomain('checks-status.example.test')
    await expect(
      pool.query(
        "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'nonsense', 'x')",
        [d],
      ),
    ).rejects.toThrow(/violates check constraint "domain_dns_checks_status_check"/)
  })

  it('accepts a detail of exactly 500 characters, and refuses one longer', async () => {
    const ok = await insertDomain('checks-detail-ok.example.test')
    await pool.query(
      'INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, $2, $3)',
      [ok, 'verified', 'x'.repeat(500)],
    )
    const tooLong = await insertDomain('checks-detail-long.example.test')
    await expect(
      pool.query('INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, $2, $3)', [
        tooLong,
        'verified',
        'x'.repeat(501),
      ]),
    ).rejects.toThrow(/violates check constraint "domain_dns_checks_detail_check"/)
  })

  it('drops the check with its domain', async () => {
    const d = await insertDomain('checks-cascade.example.test')
    await pool.query(
      "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'verified', 'ok')",
      [d],
    )
    await pool.query('DELETE FROM domains WHERE id = $1', [d])
    const left = await pool.query('SELECT 1 FROM domain_dns_checks WHERE domain_id = $1', [d])
    expect(left.rowCount).toBe(0)
  })
})
