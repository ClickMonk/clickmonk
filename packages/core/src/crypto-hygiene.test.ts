/**
 * The credential primitives' crypto hygiene, and the shared checker's own tests.
 *
 * The two modules gated here hold this install's credential logic. The check
 * reads the *body* of the one function per file that decides whether a secret
 * matches — `digestsMatch` in secrets.ts, `verifyTotp` in totp.ts — because the
 * rest of both files legitimately compares lengths, prefixes and parameters that
 * are not secret. Elsewhere the same checker reads whole files; which it reads is
 * the package's own configuration.
 *
 * The checker lives in `testing.ts` so that the admin service and the redirect
 * run the same parser over their own source. It was three copies until they
 * drifted, and the drift was the hole: this file's copy matched only `===` and
 * `!==`, so `return ok || a == b` between two secrets passed it while `===`
 * failed. The checker's remaining holes are documented where it lives; the tests
 * at the bottom of this file pin the three ways a copy was walked past.
 */
import { describe, expect, it } from 'vitest'
import {
  type HygieneConfig,
  decisionProblems,
  findDisallowedComparisons,
  gatedFiles,
  missingComparers,
  readSource,
  staleExemptions,
  staleLengthExemptions,
  unexemptedComparisons,
  whyDeciderDoesNotDecide,
} from './testing.js'

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG: HygieneConfig = {
  dir: dirname(fileURLToPath(import.meta.url)),
  /** Importing this from `node:crypto` is what makes a file a starting point. */
  primitives: ['timingSafeEqual'],
  expectedGated: ['secrets.ts', 'totp.ts'],
  expectedComparers: ['secrets.ts', 'totp.ts'],
  decider: 'timingSafeEqual',
  /** It throws on a length mismatch, so the two lengths come first. */
  lengthCheckedFirst: true,
  scope: {
    kind: 'functions',
    functions: { 'secrets.ts': 'digestsMatch', 'totp.ts': 'verifyTotp' },
  },
  allowed: [],
  lengthExempt: [
    {
      file: 'secrets.ts',
      fn: 'verifyPassword',
      because:
        'it derives the candidate key at the stored key\u2019s own length, so the ' +
        'two lengths are equal by construction and there is no mismatch for ' +
        'timingSafeEqual to throw on',
    },
  ],
  /** The checker itself, which is not credential logic. */
  skip: ['testing.ts'],
}

describe('crypto hygiene in the credential primitives', () => {
  const gated = gatedFiles(CONFIG)

  it('gates both modules that hold credential logic', () => {
    expect(gated).toEqual(expect.arrayContaining(CONFIG.expectedGated))
  })

  it('never seeds randomness with Math.random', () => {
    for (const file of CONFIG.expectedGated) {
      expect(readSource(CONFIG, file).includes('Math.random'), file).toBe(false)
    }
  })

  it('decides a match, inside the gated function, only with timingSafeEqual', () => {
    for (const file of CONFIG.expectedGated) {
      expect(unexemptedComparisons(CONFIG, file), file).toEqual([])
    }
  })

  it('has no exemption that stopped matching anything', () => {
    expect(staleExemptions(CONFIG)).toEqual([])
    expect(staleLengthExemptions(CONFIG)).toEqual([])
  })

  it('lets the result of timingSafeEqual decide the answer, file by file', () => {
    for (const file of gated) {
      expect(decisionProblems(CONFIG, file), file).toEqual([])
    }
    expect(missingComparers(CONFIG)).toEqual([])
  })
})

/**
 * The checker's own tests, over fabricated bodies rather than real files: each of
 * these is a way one of the three copies was walked past, and each belongs to the
 * checker rather than to any one package.
 */
describe('the shared checker on a body that only looks careful', () => {
  const why = (body: string): string => whyDeciderDoesNotDecide(CONFIG, body)

  it('accepts the two shapes this tree actually writes', () => {
    expect(
      why(`{
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    }`),
    ).toBe('')
    expect(
      why(`{
      const same =
        a.length === b.length &&
        timingSafeEqual(a, b)
      if (same) return 1
      return null
    }`),
    ).toBe('')
  })

  it('refuses a length check that decides nothing', () => {
    // The real guard replaced by a dead binding: the text is present, so a rule
    // that only asked whether a length comparison appeared was satisfied, and
    // timingSafeEqual then throws on a mismatched length instead of refusing.
    expect(
      why(`{
      const sameLength = a.length === b.length
      return timingSafeEqual(a, b)
    }`),
    ).toBe('the two lengths are not compared before timingSafeEqual is called')
  })

  it('refuses a bound on one length in place of comparing the two', () => {
    expect(
      why(`{
      if (a.length > 128) return false
      return timingSafeEqual(a, b)
    }`),
    ).toBe('the two lengths are not compared before timingSafeEqual is called')
  })

  it('refuses a result that is read but decides nothing', () => {
    expect(
      why(`{
      if (a.length !== b.length) return false
      const equal = timingSafeEqual(a, b)
      log(equal)
      return true
    }`),
    ).toBe("timingSafeEqual's result is assigned to a name that decides nothing")
  })

  it('refuses a call written as a discarded statement', () => {
    expect(
      why(`{
      if (a.length !== b.length) return false
      timingSafeEqual(a, b)
      return true
    }`),
    ).toBe('timingSafeEqual is neither returned nor assigned')
  })

  it('says so when the call is not there at all', () => {
    expect(why('{ return a === b }')).toBe('timingSafeEqual is not called here')
  })

  it('finds the comparisons it is there to find', () => {
    // A direct pin on the finder. Every other check here is satisfied by a
    // finder that finds nothing: this package exempts no comparison, so its
    // stale-exemption check is empty either way, and a stubbed finder left this
    // file's gate green while the other two packages' caught it.
    expect(findDisallowedComparisons('{ return given === want }').map((v) => v.expression)) //
      .toEqual(['given === want'])
    expect(findDisallowedComparisons('{ return given == want }').map((v) => v.expression)) //
      .toEqual(['given == want'])
    expect(findDisallowedComparisons('{ return a.equals(b) }').map((v) => v.expression)) //
      .toEqual(['a.equals('])
    expect(
      findDisallowedComparisons('{ return hashToken(x) === row.digest }').map((v) => v.why),
    ).toEqual(['an operand is a call or template result'])
    // And leaves alone what it is not there to find.
    expect(findDisallowedComparisons('{ if (a.length !== b.length) return null }')).toEqual([])
    expect(findDisallowedComparisons("{ if (kind === 'totp') return 1 }")).toEqual([])
  })
})
