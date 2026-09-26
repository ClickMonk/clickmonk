import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from './migrate-latest.js'
import { loadMigrations, migrate } from './migrator.js'
import { testCh, testPg } from './testing.js'

const pg = testPg()
const ch = testCh()

/**
 * Replays a real upgrade: a database migrated only as far as 009, carrying
 * checks from before `passed_at` existed, then brought up to 010. This is
 * the one case `resetDatabases` (migrate-from-nothing, used by every other
 * test file) cannot exercise, and the one migration 010 is about: a domain
 * whose last check already said 'verified' before this column existed must
 * come out the upgrade with `passed_at` backfilled, not null.
 */
describe('migration 010: domain_dns_checks.passed_at', () => {
  afterAll(async () => {
    await pg.end()
    await ch.close()
  })

  it('adds the column, backfills a passed check, and leaves a failed one null', async () => {
    await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    const rs = await ch.query({ query: 'SHOW TABLES', format: 'JSONEachRow' })
    for (const { name } of await rs.json<{ name: string }>()) {
      await ch.command({ query: `DROP TABLE IF EXISTS \`${name.replace(/`/g, '')}\`` })
    }

    const all = loadMigrations(MIGRATIONS_DIR)
    const upTo9 = all.filter((m) => m.version <= 9)
    expect(upTo9.length).toBeLessThan(all.length)
    await migrate({ pg, ch, migrations: upTo9, appSchemaVersion: 9 })

    // A pre-010 database: two domains, one whose last check found the token
    // and one whose last check did not — written with the columns 009 knew
    // about, exactly as an installed database would have them.
    await pg.query(`INSERT INTO domains (id, host, verification_token) VALUES
      ('00000000-0000-4000-8000-000000000a01', 'passed.example.test', '${'a'.repeat(32)}'),
      ('00000000-0000-4000-8000-000000000a02', 'failed.example.test', '${'b'.repeat(32)}')`)
    await pg.query(`INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at) VALUES
      ('00000000-0000-4000-8000-000000000a01', 'verified', 'ok', '2026-09-01T00:00:00.000Z'),
      ('00000000-0000-4000-8000-000000000a02', 'missing_token', 'no record', '2026-09-02T00:00:00.000Z')`)

    const result = await migrate({ pg, ch, migrations: all, appSchemaVersion: 10 })
    expect(result.applied).toEqual([10])

    const rows = await pg.query<{ host: string; passed_at: Date | null; checked_at: Date }>(
      `SELECT d.host, c.passed_at, c.checked_at
         FROM domain_dns_checks c JOIN domains d ON d.id = c.domain_id
        ORDER BY d.host`,
    )
    const passed = rows.rows.find((r) => r.host === 'passed.example.test')
    const failed = rows.rows.find((r) => r.host === 'failed.example.test')
    expect(passed?.passed_at?.toISOString()).toBe(passed?.checked_at.toISOString())
    expect(failed?.passed_at).toBeNull()

    // Applying it again is a no-op: the ledger already has 010.
    expect((await migrate({ pg, ch, migrations: all, appSchemaVersion: 10 })).applied).toEqual([])
  })
})
