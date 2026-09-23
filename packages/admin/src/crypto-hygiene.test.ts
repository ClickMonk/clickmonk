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
  MODULE_LEVEL,
  decisionProblems,
  gatedFiles,
  localImports,
  missingComparers,
  readSource,
  sourceFiles,
  staleExemptions,
  staleLengthExemptions,
  unexemptedComparisons,
} from '@clickmonk/core/testing'
import { describe, expect, it } from 'vitest'

const ALLOWED: Exemption[] = [
  {
    file: 'account.ts',
    fn: 'signIn',
    expression: 'normaliseEmail(input.email) === account.email',
    because:
      'a sign-in checks the address it was given against the one address this ' +
      'install has; an email is an identifier, not a secret, and the password ' +
      'below it is measured against a throwaway hash either way, so the answer ' +
      'takes the same work whether the address matched',
  },
  {
    file: 'app.ts',
    fn: 'buildAdminApp',
    expression: "normaliseHost(req.hostname ?? '') !== ctx.adminHost",
    because:
      'the admin host guard compares the requested host to the configured one; ' +
      'neither is secret, and which host this service answers on is visible to ' +
      'anyone who connects to it',
  },
  {
    file: 'config.ts',
    fn: MODULE_LEVEL,
    expression: 'normaliseHost(value) !== value',
    because:
      'configuration validation, refusing a host that is not already in its ' +
      'normal form; it runs at boot on a value from the environment',
  },
  {
    file: 'session-routes.ts',
    fn: 'registerSessionRoutes',
    expression: 's.id === credential.id',
    because:
      "marks which row in the admin's own list of sessions is the one they are " +
      'signed in with; a session id is not its token, and the token is never ' +
      'compared in this process at all',
  },
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
  /**
   * The entry point, so the set is every file this service runs rather than the
   * three that import a primitive. Seeded from the primitives alone it was 3 of
   * 11, and `return presented === stored` in `session-routes.ts` was invisible —
   * the same defeat the redirect's gate now fails on, in the package that owns
   * sessions, recovery codes and API keys.
   */
  alwaysSeed: ['index.ts'],
  expectedGated: [
    'account.ts',
    'app.ts',
    'auth.ts',
    'config.ts',
    'domains.ts',
    'http.ts',
    'index.ts',
    'keys.ts',
    'links.ts',
    'session-routes.ts',
    'settings-routes.ts',
  ],
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
    // Both lists, in every package: asserting this in one package left an
    // exemption added in another checked by nothing.
    expect(staleLengthExemptions(CONFIG)).toEqual([])
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
