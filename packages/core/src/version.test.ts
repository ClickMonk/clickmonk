import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './index.js'
import { VERSION } from './version.js'

describe('SCHEMA_VERSION', () => {
  it('is the highest migration version this build knows about', () => {
    // Bumped with every migration added. packages/db's
    // schema-version.test.ts ties it to the migration files on disk.
    expect(SCHEMA_VERSION).toBe(10)
  })
})

// packages/core/src -> the repository root.
const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Every manifest a release bumps: the root's, and one per package. */
function manifests(): { file: string; version: unknown }[] {
  const files = [
    'package.json',
    ...readdirSync(join(ROOT, 'packages')).map((p) => join('packages', p, 'package.json')),
  ]
  return files.map((file) => ({
    file,
    version: (JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { version?: unknown }).version,
  }))
}

describe('VERSION', () => {
  it('is a plain release number, with no prefix and no pre-release tag', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // A release bumps every manifest and this constant together. A bump that
  // misses one leaves a package claiming a version nobody released, and the
  // constant is what `clickmonk version` prints, so it has to be the same
  // number everywhere or the answer an operator gives in a bug report is wrong.
  it('is the version every package.json in the repository carries, the root included', () => {
    const found = manifests()
    // Eight packages and the root. Written out, so a ninth package that is
    // never given a version fails here rather than being skipped.
    expect(found).toHaveLength(9)
    for (const { file, version } of found) expect(version, file).toBe(VERSION)
  })
})
