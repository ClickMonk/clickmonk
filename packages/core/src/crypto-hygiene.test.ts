/**
 * A gate on the two modules that hold this install's credential logic, not on
 * behaviour: neither "this used a real CSPRNG" nor "this compared in constant
 * time" is observable by calling the functions, since both properties are
 * about *how* the answer was computed, not what it is. This reads the source
 * text instead, so a regression here fails at the same commit that
 * introduces it rather than waiting on a call that happens to expose it.
 *
 * The comparison gate reads the *body* of the one function per file that
 * decides whether a secret matches — `digestsMatch` in secrets.ts,
 * `verifyTotp` in totp.ts — found by its declaration and brace-balance, never
 * by what its local variables are named. A rename inside either function (of
 * `bufA`, `expected`, anything) cannot evade this: an earlier version of this
 * gate matched on identifiers that merely *looked* credential-shaped, and
 * `return bufA.equals(bufB)` — or replacing the whole body with `a === b` —
 * passed it, because `bufA` and `a` don't look like a digest, secret, token,
 * hash or code. This version doesn't ask what anything is called.
 *
 * Scope: these two files and these two functions only. It does not travel to
 * other packages — the admin service will compare a presented password,
 * session token or API key against a stored value too, on its own request
 * path, and needs its own version of this gate, not an import of this one.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const GATED_FILES = ['secrets.ts', 'totp.ts']

/** The one function per file that decides whether a secret matches. */
const GATED_FUNCTIONS: Record<string, string> = {
  'secrets.ts': 'digestsMatch',
  'totp.ts': 'verifyTotp',
}

/**
 * The text of one function's body, found by brace-balance from its
 * declaration rather than by "the first `{` after the name": `verifyTotp`'s
 * parameter is itself an inline object type (`o: { secret: string; … }`),
 * so the first `{` after the name opens *that*, not the body. This instead
 * balances parentheses to the end of the parameter list, then balances
 * braces from the first `{` after that — which is the body, whatever the
 * parameter list or return type look like, as long as neither contains an
 * unbalanced paren (true of every TypeScript type).
 */
function extractFunctionBody(source: string, name: string): string {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source)
  if (!declaration) throw new Error(`${name} not found`)
  let i = declaration.index + declaration[0].length - 1 // at the parameter list's '('
  let parenDepth = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') parenDepth++
    else if (source[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        i++
        break
      }
    }
  }
  const openBrace = source.indexOf('{', i)
  if (openBrace === -1) throw new Error(`${name} has no body`)
  let braceDepth = 0
  for (let j = openBrace; j < source.length; j++) {
    if (source[j] === '{') braceDepth++
    else if (source[j] === '}') {
      braceDepth--
      if (braceDepth === 0) return source.slice(openBrace, j + 1)
    }
  }
  throw new Error(`${name}'s body never closes`)
}

/**
 * `===`/`!==` inside a gated body are not banned outright: both functions
 * legitimately compare a length to a length, or a value to `null`, before
 * ever reaching the secret material itself — `bufA.length !== bufB.length`,
 * `expected === null`. Neither operand there is the thing being verified.
 * What is banned is a comparison where *neither* side is one of those: that
 * is a comparison of the secret material itself, which must go through
 * `timingSafeEqual` instead. `.equals(` is banned unconditionally — neither
 * function has a legitimate use for it today.
 */
function findDisallowedComparisons(body: string): string[] {
  const violations: string[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) violations.push(match[0])
  const isSafeOperand = (token: string): boolean =>
    token === 'null' || /\.length$/.test(token) || /^\d+$/.test(token)
  const chain = '[\\w$]+(?:\\.[\\w$]+)*'
  const comparison = new RegExp(`(${chain})\\s*(===|!==)\\s*(${chain}|\\d+)`, 'g')
  for (const match of body.matchAll(comparison)) {
    const [full, lhs, , rhs] = match
    if (!(isSafeOperand(lhs as string) || isSafeOperand(rhs as string))) {
      violations.push(full)
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

  it('uses timingSafeEqual somewhere in the file', () => {
    for (const { name, source } of files) {
      expect(source.includes('timingSafeEqual('), name).toBe(true)
    }
  })

  it('decides a match, inside the gated function, only with timingSafeEqual', () => {
    for (const { name, source } of files) {
      const fnName = GATED_FUNCTIONS[name] as string
      const body = extractFunctionBody(source, fnName)
      const label = `${name}#${fnName}`
      expect(body.includes('timingSafeEqual('), label).toBe(true)
      expect(findDisallowedComparisons(body), label).toEqual([])
    }
  })
})
