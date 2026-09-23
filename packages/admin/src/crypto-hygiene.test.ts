import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * The admin service's crypto hygiene: this package's seeds, floor, exemptions
 * and deciding call, checked by the one shared checker.
 *
 * It is here because a gate reads its own package's source and nothing else. The
 * checker itself, and every hole it still has, is documented where it lives.
 *
 * A session token is not compared in JavaScript anywhere in this package: its
 * digest is the indexed key its row is found by, so the comparison is
 * Postgres's, against a fixed-width digest, and there is no branch here that
 * could return early on a differing byte.
 */
import {
  type Exemption,
  type HygieneConfig,
  decisionProblems,
  gatedFiles,
  localImports,
  missingComparers,
  readSource,
  sourceFiles,
  staleExemptions,
  unexemptedComparisons,
} from '@clickmonk/core/testing'
import { describe, expect, it } from 'vitest'

const ALLOWED: Exemption[] = [
  {
    file: 'auth.ts',
    fn: 'checkCsrf',
    expression: 'o.origin !== expected',
    because:
      'the cross-site write guard compares a request header to the admin origin; ' +
      'neither is secret, and the answer is the same to everyone',
  },
]

const CONFIG: HygieneConfig = {
  dir: dirname(fileURLToPath(import.meta.url)),
  /**
   * The primitives whose output is compared *in this process*: a digest to
   * check, the comparison itself, the parse that splits a presented key, and the
   * mint that produces the value on the other side of one. Password and
   * one-time-code verification are not here because they never return something
   * this package compares — that comparison happens inside the core package,
   * which configures the same checker over exactly that.
   */
  primitives: ['digestsMatch', 'hashToken', 'parseApiKey', 'newOpaqueToken', 'newApiKey'],
  expectedGated: ['auth.ts', 'http.ts', 'keys.ts'],
  expectedComparers: ['auth.ts'],
  decider: 'digestsMatch',
  /** `digestsMatch` does its own length check and does not throw on a mismatch. */
  lengthCheckedFirst: false,
  scope: { kind: 'whole-file' },
  allowed: ALLOWED,
  skip: ['testing.ts'],
}

describe('crypto hygiene in the admin service', () => {
  const gated = gatedFiles(CONFIG)

  it('never reaches for Math.random', () => {
    // Nothing in this package has a use for a non-cryptographic random number,
    // and one file here mints a throwaway password hash that a sign-in against
    // an unknown address is measured against.
    for (const file of sourceFiles(CONFIG)) {
      expect(readSource(CONFIG, file).includes('Math.random'), file).toBe(false)
    }
  })

  it('gates every file that can reach a credential primitive', () => {
    expect(gated).toEqual(expect.arrayContaining(CONFIG.expectedGated))
  })

  it('compares a credential, in every gated file, only with digestsMatch', () => {
    for (const file of gated) {
      expect(unexemptedComparisons(CONFIG, file), file).toEqual([])
    }
  })

  it('has no exemption that stopped matching anything', () => {
    expect(staleExemptions(CONFIG)).toEqual([])
  })

  it('lets the result of digestsMatch decide the answer, file by file', () => {
    for (const file of gated) {
      expect(decisionProblems(CONFIG, file), file).toEqual([])
    }
    expect(missingComparers(CONFIG)).toEqual([])
  })

  it('classifies a re-export by its own statement, not the one above it', () => {
    const reExport = "export { compare } from './helper.js'\n"
    const here = CONFIG.dir
    expect(
      localImports(here, 'keys.ts', `import type { AdminContext } from './app.js'\n${reExport}`),
    ) //
      .toEqual(['helper.ts'])
    expect(localImports(here, 'keys.ts', `import { requireSession } from './auth.js'\n${reExport}`)) //
      .toEqual(['auth.ts', 'helper.ts'])
    expect(localImports(here, 'keys.ts', "export type { Shape } from './helper.js'\n")).toEqual([])
    expect(localImports(here, 'keys.ts', `import { z } from 'zod'\n${reExport}`)) //
      .toEqual(['helper.ts'])
    // A statement that shares a line with the one before it is still its own.
    expect(localImports(here, 'keys.ts', `import type { A } from './app.js'; ${reExport}`)) //
      .toEqual(['helper.ts'])
  })
})
