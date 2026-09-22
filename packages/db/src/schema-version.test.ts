import { SCHEMA_VERSION } from '@clickmonk/core'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from './migrate-latest.js'
import { loadMigrations } from './migrator.js'

/**
 * migrate() throws SchemaTooNewError when the highest applied version exceeds
 * SCHEMA_VERSION. Adding a migration without bumping the constant passes every
 * other test and crash-loops an operator on their SECOND boot after upgrading.
 * This makes the mistake fail here, when it is made.
 */
describe('SCHEMA_VERSION', () => {
  it('matches the highest migration on disk', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    expect(migrations.length).toBeGreaterThan(0)
    expect(SCHEMA_VERSION).toBe(Math.max(...migrations.map((m) => m.version)))
  })
})
