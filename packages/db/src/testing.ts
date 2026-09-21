import { type ClickHouseClient, type Pool, createChClient, createPgPool } from './clients.js'
import { migrateToLatest } from './migrate-latest.js'

export const TEST_PG_URL = 'postgres://clickmonk:clickmonk@localhost:5433/clickmonk_test'
export const TEST_CH = {
  url: 'http://localhost:8123',
  username: 'clickmonk',
  password: 'clickmonk',
  database: 'clickmonk_test',
}

export function testPg(): Pool {
  return createPgPool(TEST_PG_URL)
}

export function testCh(): ClickHouseClient {
  return createChClient(TEST_CH)
}

/**
 * Drops every table in both test databases and migrates from nothing. Call it
 * at the TOP of beforeAll: a file that only cleans up on the way out is still
 * dirty after a previous run crashed.
 */
export async function resetDatabases(pg: Pool, ch: ClickHouseClient): Promise<void> {
  await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  const rs = await ch.query({ query: 'SHOW TABLES', format: 'JSONEachRow' })
  for (const { name } of await rs.json<{ name: string }>()) {
    await ch.command({ query: `DROP TABLE IF EXISTS \`${name.replace(/`/g, '')}\`` })
  }
  await migrateToLatest(pg, ch)
}
