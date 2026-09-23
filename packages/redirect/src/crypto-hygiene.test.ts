import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * The redirect's crypto hygiene: this package's seeds, floor, exemptions and
 * deciding call, checked by the one shared checker.
 *
 * It is here because a gate reads its own package's source and nothing else, so
 * a `===` written in this package is invisible to the other packages' gates. The
 * checker itself, and every hole it still has, is documented where it lives.
 *
 * This is the first secret comparison in the redirect and the only one an
 * anonymous visitor drives: the proof cookie on a password-protected link is
 * checked on every request to that link, by whoever asks.
 */
import {
  type Exemption,
  type HygieneConfig,
  MODULE_LEVEL,
  decisionProblems,
  gatedFiles,
  localImports,
  missingComparers,
  sourceFiles,
  staleExemptions,
  staleLengthExemptions,
  unexemptedComparisons,
} from '@clickmonk/core/testing'
import { describe, expect, it } from 'vitest'

/**
 * Both of these sit in a class method, which the checker attributes to
 * `(module)` because it finds `function` declarations and not methods. The
 * expression text is still exact, so the exemption is narrow; what it does not
 * do is distinguish two methods of the same class.
 */
const IN_A_CLASS_METHOD = MODULE_LEVEL

/**
 * Comparisons of things that are not secret, each exempt by exact text in one
 * file and one declared function.
 */
const ALLOWED: Exemption[] = [
  {
    file: 'password.ts',
    fn: 'cookieValue',
    expression: 'key === name',
    because:
      'finds a cookie by its name; a cookie name is not secret, and which ' +
      'name is present is already visible to whoever sent the header',
  },
  {
    file: 'visitor.ts',
    fn: 'visitorCookies',
    expression: 'id !== seenLinkId',
    because:
      'keeps one link id from appearing twice in the seen list; both are ids ' +
      'the visitor was already sent',
  },
  {
    file: 'snapshot.ts',
    fn: IN_A_CLASS_METHOD,
    expression: 'gen === this.reloadGen',
    because:
      'a reload compares its own generation number with the latest, to drop a ' +
      'result a newer reload has already superseded; a counter is not a secret',
  },
  {
    file: 'snapshot.ts',
    fn: IN_A_CLASS_METHOD,
    expression: 'this.listener === client',
    because:
      'the config listener checks whether the connection that dropped is still ' +
      'the one it holds; an object identity, not a secret',
  },
]

const CONFIG: HygieneConfig = {
  dir: dirname(fileURLToPath(import.meta.url)),
  /**
   * The two primitives this package's own comparison is built from, and the two
   * whose output decides whether a visitor has answered a link's password.
   */
  primitives: ['timingSafeEqual', 'createHmac', 'passwordFingerprint', 'verifyPassword'],
  /**
   * The entry point, so the set is every file this service runs rather than
   * every file that happens to import a primitive. With only the primitives as
   * seeds the set was four files, and `return presented === stored` added to
   * `internal.ts` — the endpoint that decides whether this install asks for a
   * certificate — was invisible to the gate, which the floor below cannot notice
   * because the walk never reached the file.
   */
  alwaysSeed: ['index.ts'],
  /**
   * `cap.ts` is on the floor because the walk reaches it: `app.ts` imports it
   * for a value, so it is scanned, and a file that is scanned belongs on the
   * floor or the floor is not one.
   */
  expectedGated: [
    'app.ts',
    'cap.ts',
    'config.ts',
    'index.ts',
    'internal.ts',
    'password.ts',
    'rate.ts',
    'snapshot.ts',
    'spool.ts',
    'visitor.ts',
    'write-all.ts',
  ],
  expectedComparers: ['password.ts', 'visitor.ts'],
  decider: 'timingSafeEqual',
  lengthCheckedFirst: true,
  scope: { kind: 'whole-file' },
  allowed: ALLOWED,
}

describe('crypto hygiene in the redirect', () => {
  const gated = gatedFiles(CONFIG)

  it('gates every file in the package', () => {
    // Every file, exactly — not a superset. Seeded from the entry point the walk
    // reaches all of them, so `arrayContaining` would no longer be pinning
    // anything: a file that left the set could only be one that stopped being
    // reachable, and this says so directly.
    expect(gated).toEqual(sourceFiles(CONFIG))
    expect(gated).toEqual(CONFIG.expectedGated)
  })

  it('compares a secret, in every gated file, only with timingSafeEqual', () => {
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

  it('lets the result of timingSafeEqual decide the answer, file by file', () => {
    for (const file of gated) {
      expect(decisionProblems(CONFIG, file), file).toEqual([])
    }
    // And a floor under that: these files compare, whatever their text says
    // today. Deleting a call and its import together is a real edit — an unused
    // import is a lint error — and without this it left an inferred set quietly.
    expect(missingComparers(CONFIG)).toEqual([])
  })

  it('classifies a re-export by its own statement, not the one above it', () => {
    // A re-export carries no `import` keyword of its own, so which statement it
    // belongs to has to be decided by where that statement starts.
    const reExport = "export { compare } from './helper.js'\n"
    const here = CONFIG.dir
    expect(
      localImports(here, 'app.ts', `import type { Snapshot } from './snapshot.js'\n${reExport}`),
    ) //
      .toEqual(['helper.ts'])
    expect(localImports(here, 'app.ts', `import { readVisitor } from './visitor.js'\n${reExport}`)) //
      .toEqual(['visitor.ts', 'helper.ts'])
    expect(localImports(here, 'app.ts', "export type { Shape } from './helper.js'\n")).toEqual([])
    expect(localImports(here, 'app.ts', `import Fastify from 'fastify'\n${reExport}`)) //
      .toEqual(['helper.ts'])
  })
})
