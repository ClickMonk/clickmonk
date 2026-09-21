import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './index.js'

describe('SCHEMA_VERSION', () => {
  it('is the highest migration version this build knows about', () => {
    // Bumped by every task that adds a migration. packages/db's
    // schema-version.test.ts ties it to the files on disk once they exist.
    expect(SCHEMA_VERSION).toBe(0)
  })
})
