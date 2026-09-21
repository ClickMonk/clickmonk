import { join } from 'node:path'
import { SCHEMA_VERSION } from '@clickmonk/core'
import type { ClickHouseClient, Pool } from './clients.js'
import { loadMigrations, migrate } from './migrator.js'

/** packages/db/migrations, resolved from dist/ at runtime and from src/ under test. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

export function migrateToLatest(pg: Pool, ch: ClickHouseClient): Promise<{ applied: number[] }> {
  return migrate({
    pg,
    ch,
    migrations: loadMigrations(MIGRATIONS_DIR),
    appSchemaVersion: SCHEMA_VERSION,
  })
}
