import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './index.js'

describe('SCHEMA_VERSION', () => {
  it('is the highest migration version this build knows about', () => {
    // Bumped with every migration added. packages/db's
    // schema-version.test.ts ties it to the migration files on disk.
    expect(SCHEMA_VERSION).toBe(6)
  })
})
