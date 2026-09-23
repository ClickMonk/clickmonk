/**
 * A gate on the two modules that hold this install's credential logic, not on
 * behaviour: neither "this used a real CSPRNG" nor "this compared in constant
 * time" is observable by calling the functions, since both properties are
 * about *how* the answer was computed, not what it is. This reads the source
 * text instead, so a regression here fails at the same commit that
 * introduces it rather than waiting on a call that happens to expose it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const GATED_FILES = ['secrets.ts', 'totp.ts']
const CREDENTIAL_LIKE = /(digest|secret|token|hash|code)/i

/** A module constant in this tree's own SCREAMING_SNAKE_CASE convention — a
 * bound, a count or a byte length, such as `RECOVERY_CODE_CHARS` or
 * `TOKEN_BYTES` — never the runtime value of a credential itself. */
const IS_CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * Every bare identifier adjacent to `===`, `!==` or `.equals(` that looks
 * like it names a credential's runtime value. Deliberately narrow to the
 * identifier directly touching the operator — `expected.length === code.length`
 * compares two `.length` properties, not `code` itself, so it is not a
 * violation; this only ever captures the token immediately next to the
 * comparison. A module constant is excluded: `RECOVERY_CODE_CHARS` names a
 * character count, not a code.
 */
function findCredentialComparisons(source: string): string[] {
  const violations: string[] = []
  const patterns = [
    // The identifier directly before the operator: `.` breaks `[\w$]*`, so
    // `code.length === x` naturally captures `length`, not `code`.
    /([A-Za-z_$][\w$]*)\s*(?:===|!==)/g,
    // The mirror case on the right: `x === code.length` would otherwise
    // capture `code`, the first segment of the chain, not what is actually
    // compared — excluded whenever a `.` immediately follows the capture.
    /(?:===|!==)\s*([A-Za-z_$][\w$]*)(?!\.\w)/g,
    /([A-Za-z_$][\w$]*)\.equals\(/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const identifier = match[1] as string
      if (CREDENTIAL_LIKE.test(identifier) && !IS_CONSTANT_NAME.test(identifier)) {
        violations.push(match[0].trim())
      }
    }
  }
  return violations
}

describe('crypto hygiene in secrets.ts and totp.ts', () => {
  const files = GATED_FILES.map((name) => ({
    name,
    source: readFileSync(join(here, name), 'utf8'),
  }))

  it('never seeds randomness with Math.random', () => {
    for (const { name, source } of files) {
      expect(source.includes('Math.random'), name).toBe(false)
    }
  })

  it('never compares a digest-, secret-, token-, hash- or code-named value with === or .equals()', () => {
    for (const { name, source } of files) {
      const violations = findCredentialComparisons(source)
      expect(violations, `${name}: ${violations.join(', ')}`).toEqual([])
    }
  })
})
