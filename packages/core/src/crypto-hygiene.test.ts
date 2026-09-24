/**
 * The credential primitives' crypto hygiene, and the shared checker's own tests.
 *
 * This package holds the credential logic every other one leans on, so the gate
 * is the same shape as the admin service's and the redirect's: seeded from the
 * entry point, it reaches every file, and it reads every file whole. It used to
 * read the *body* of two named functions in two named files, which was narrower
 * than it looked in two directions at once — a new file exporting a secret
 * comparison was never read, and neither was a comparison planted in a function
 * the list did not name inside a file it did. The price of reading everything is
 * the exemptions below: seven comparisons of things that are not secret, each one
 * named with its reason, which is a list that says something rather than a scope
 * that hides what it skipped. Not one of them touches secret material, which is
 * the answer to the question the narrow scope was never able to ask.
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
  type Exemption,
  type HygieneConfig,
  MODULE_LEVEL,
  callSites,
  callText,
  decisionProblems,
  findDisallowedComparisons,
  gatedFiles,
  missingComparers,
  readSource,
  sourceFiles,
  staleExemptions,
  staleLengthExemptions,
  unexemptedComparisons,
  whyOneCallDoesNotDecide,
} from './testing.js'

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED: Exemption[] = [
  {
    file: 'admin-host.ts',
    fn: MODULE_LEVEL,
    expression: 'normaliseHost(value) !== value',
    because:
      'the configuration schema refuses a host name it would have had to ' +
      'rewrite; the name the admin API answers on is visible to anyone who ' +
      'connects to it, and the value being checked came from this install\u2019s ' +
      'own environment',
  },
  {
    file: 'domain-verification.ts',
    fn: 'txtRecordsCarryToken',
    expression: "chunks.join('').trim() === want",
    because:
      'a TXT record is published in public DNS and is read by anyone who asks ' +
      'for it, so the token it carries is not secret by the time it is ' +
      'compared, and nothing about how long the comparison took tells a caller ' +
      'anything a DNS query would not',
  },
  {
    file: 'link.ts',
    fn: MODULE_LEVEL,
    expression: "u.protocol !== 'https",
    because:
      'a destination URL must be http or https; a scheme is part of a value an ' +
      'operator typed and is sent to the visitor in a Location header',
  },
  {
    file: 'link.ts',
    fn: MODULE_LEVEL,
    expression: "u.protocol !== 'http",
    because: 'the other half of the same scheme check, on the same URL',
  },
  {
    file: 'secrets.ts',
    fn: 'parseStoredHash',
    expression: 'parts[0] !== SCRYPT_PREFIX',
    because:
      'the parser refuses a stored value whose first field is not this ' +
      'install\u2019s hash label; the label is a constant in this file and is the ' +
      'same for every account, so it is not material and no secret is read ' +
      'before it matches',
  },
  {
    file: 'settings.ts',
    fn: MODULE_LEVEL,
    expression: "s.actions[c] === 'safe'",
    because:
      'the settings schema checks whether a traffic class was given the safe ' +
      'action, so that it can insist on a safe URL to send it to; an action ' +
      'name is configuration an operator typed and is not secret',
  },
  {
    file: 'traffic.ts',
    fn: 'classifyTraffic',
    expression: 'SIGNAL_CLASS[s] === c',
    because:
      'the classifier asks which class a signal belongs to, against a table in ' +
      'this file; both sides are class names and neither depends on a request',
  },
]

const CONFIG: HygieneConfig = {
  dir: dirname(fileURLToPath(import.meta.url)),
  /** Importing this from `node:crypto` is what makes a file a starting point. */
  primitives: ['timingSafeEqual'],
  /**
   * The entry point, so the set is every file this package ships rather than the
   * two that import the primitive. Seeded from the primitive alone it was 2 of
   * 19, and a new file here exporting `if (presented === stored) return true`
   * was invisible — in the package that owns password hashing, API key parsing
   * and one-time codes.
   */
  alwaysSeed: ['index.ts'],
  /**
   * Empty because the floor is not a list any more: seeded from the entry point
   * the walk reaches every file in the package, so the test asserts exactly that
   * and there is no list to keep in step. A list would have had to be edited
   * every time the package gained a file, which is a tripwire that teaches
   * nothing — the assertion below already fails if a file stops being reachable.
   */
  expectedGated: [],
  expectedComparers: ['secrets.ts', 'totp.ts'],
  decider: 'timingSafeEqual',
  /** It throws on a length mismatch, so the two lengths come first. */
  lengthCheckedFirst: true,
  scope: { kind: 'whole-file' },
  allowed: ALLOWED,
  lengthExempt: [
    {
      file: 'secrets.ts',
      fn: 'verifyPassword',
      call: 'timingSafeEqual(key, parsed.key)',
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

  it('gates every file in the package', () => {
    // Every file, exactly. Seeded from the entry point the walk reaches all of
    // them, so `arrayContaining` over a hand-kept list would pin less than this
    // and rot faster: a file that left the set could only be one that stopped
    // being reachable, and this says so directly.
    expect(gated).toEqual(sourceFiles(CONFIG))
  })

  it('never seeds randomness with Math.random', () => {
    for (const file of sourceFiles(CONFIG)) {
      expect(readSource(CONFIG, file).includes('Math.random'), file).toBe(false)
    }
  })

  it('decides a match, in every gated file, only with timingSafeEqual', () => {
    for (const file of gated) {
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
  const DEAD =
    "timingSafeEqual's result is consumed beside a comparison against a number written in the source"

  /** The first call in a body, which is what these fixtures each hold. */
  const why = (body: string): string =>
    whyOneCallDoesNotDecide(CONFIG, body, callSites(body, 'timingSafeEqual')[0] ?? -1)

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

  it('refuses a result consumed beside a comparison against a written number', () => {
    // The name appears in an `if`, and the branch is dead. This is one spelling
    // of that, not a liveness check: `if (!equal && a === null)` decides just as
    // little and is not matched, which the checker's own header says plainly
    // rather than implying otherwise.
    expect(
      why(`{
      if (a.length !== b.length) return false
      const equal = timingSafeEqual(a, b)
      if (!equal && a.length < 0) return false
      return true
    }`),
    ).toBe(DEAD)
    // And the same shape where the call is consumed in place.
    expect(
      why(`{
      if (a.length !== b.length) return false
      if (!timingSafeEqual(a, b) && a.length < 0) return false
      return true
    }`),
    ).toBe(DEAD)
    // The spelling it does not catch, asserted as not caught: a reader comparing
    // this suite with the header should find them saying the same thing.
    expect(
      why(`{
      if (a.length !== b.length) return false
      const equal = timingSafeEqual(a, b)
      if (!equal && a === null) return false
      return true
    }`),
    ).toBe('')
  })

  it('inspects every call, not only the first', () => {
    // A guarded call followed by an unguarded one: reading only the first left
    // the second invisible.
    const body = `{
      if (a.length !== b.length) return false
      const first = timingSafeEqual(a, b)
      const second = timingSafeEqual(c, d)
      return first && second
    }`
    const sites = callSites(body, 'timingSafeEqual')
    expect(sites).toHaveLength(2)
    expect(whyOneCallDoesNotDecide(CONFIG, body, sites[0] as number)).toBe('')
    expect(whyOneCallDoesNotDecide(CONFIG, body, sites[1] as number)).toBe(
      'the two lengths are not compared before timingSafeEqual is called',
    )
    // The exemption is the call's, not the function's, so it does not travel to
    // the second call.
    expect(callText(body, sites[1] as number, 'timingSafeEqual')).toBe('timingSafeEqual(c, d)')
  })

  it('checks a length exemption written for an expression outside any function', () => {
    // Nothing declares a function called `(module)`, so looking one up reported
    // every such exemption stale — the mirror of a bug already fixed on the
    // comparison side. It failed in the safe direction, which is why it sat
    // unnoticed: the exemption could not hide anything, it just could not be
    // written. Both sides search the whole file for it now.
    const asModule: HygieneConfig = {
      ...CONFIG,
      lengthExempt: [
        {
          file: 'secrets.ts',
          fn: MODULE_LEVEL,
          call: 'timingSafeEqual(bufA, bufB)',
          because: 'a fixture: this call is real, and it is not in a function of that name',
        },
      ],
    }
    expect(staleLengthExemptions(asModule)).toEqual([])
    // And it is still checked, rather than waved through for being `(module)`.
    const gone: HygieneConfig = {
      ...asModule,
      lengthExempt: [
        {
          ...(asModule.lengthExempt?.[0] as NonNullable<HygieneConfig['lengthExempt']>[number]),
          call: 'timingSafeEqual(nothing, missing)',
        },
      ],
    }
    expect(staleLengthExemptions(gone)).toHaveLength(1)
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
