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
 * A later round found two more ways past a text-only gate:
 * `bufA.toString('hex') === bufB.toString('hex')` routes the comparison
 * through a call, which the identifier-chain matcher could not span; and a
 * `timingSafeEqual(` left commented out, or written as a discarded statement
 * that is never returned or assigned, satisfied a check that only asked
 * whether the text was present *anywhere* in the body. Both are closed below.
 *
 * **What this gate is, and is not.** It is a tripwire for a careless edit —
 * a rename, a "simplify this" pass, a copy-paste from the wrong function —
 * not a proof against a determined author: it reads text, not semantics, and
 * a comparison that avoids `===`, `!==` and `.equals(` entirely (bitwise
 * work on the buffers, a hand-rolled loop, a third comparison method this
 * file has never heard of) is invisible to it. It does not prove the
 * winning comparison actually runs in constant time — only that the source
 * calls the function this codebase uses for that. And it does not travel to
 * other packages: the admin service will compare a presented password,
 * session token or API key against a stored value too, on its own request
 * path, and needs its own version of this gate, not an import of this one
 * assumed to already cover it.
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

/** Removes line comments and block comments, so a check further down never
 * counts dead, commented-out text as evidence that live code does something. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
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
 * The last non-whitespace character of the operand immediately to the left
 * of a `===`/`!==` at `opStart` — which, for any valid expression, is simply
 * whatever character sits there once whitespace is skipped.
 */
function lhsEndChar(text: string, opStart: number): string {
  let i = opStart - 1
  while (i >= 0 && /\s/.test(text[i] as string)) i--
  return i >= 0 ? (text[i] as string) : ''
}

/**
 * The last non-whitespace character of the operand immediately to the right
 * of a `===`/`!==` ending at `opEnd`. Unlike the left side, the right
 * operand's extent has to be found by scanning forward: a call
 * (`bufB.toString('hex')`) has its own balanced parens, so the operand does
 * not end at the first `)` — it ends at the `)` that returns paren depth to
 * zero, or at `&&`, `||`, `;`, `,` or a newline at depth zero, whichever
 * comes first. A depth-zero `)` belongs to whatever encloses the comparison
 * (an `if (...)`, typically) and is not part of the operand.
 */
function rhsEndChar(text: string, opEnd: number): string {
  let i = opEnd
  while (i < text.length && /\s/.test(text[i] as string)) i++
  let depth = 0
  let last = ''
  for (; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '(') {
      depth++
      last = ch
      continue
    }
    if (ch === ')') {
      if (depth === 0) break
      depth--
      last = ch
      continue
    }
    if (depth === 0 && (text.startsWith('&&', i) || text.startsWith('||', i))) break
    if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) break
    if (!/\s/.test(ch)) last = ch
  }
  return last
}

/**
 * `===`/`!==` inside a gated body are not banned outright: both functions
 * legitimately compare a length to a length, or a value to `null`, before
 * ever reaching the secret material itself — `bufA.length !== bufB.length`,
 * `expected === null`. Neither operand there is the thing being verified.
 *
 * Two things are banned regardless of what is on the other side. `.equals(`
 * — neither function has a legitimate use for it today. And a comparison
 * where either operand ends in `)` or a backtick: a call result or a
 * template result, which routes the comparison around whatever the operand
 * "looks like" as plain text — `bufA.toString('hex') === bufB.toString('hex')`
 * compares two strings built from the secret material, not the material
 * itself, and no identifier-based check can tell that from a length check.
 *
 * Anything else is banned unless at least one side is `null`, a `.length`
 * chain, or a numeric literal — the same allow-list as before.
 */
function findDisallowedComparisons(body: string): string[] {
  const violations: string[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) violations.push(match[0])

  const isSafeOperand = (token: string): boolean =>
    token === 'null' || /\.length$/.test(token) || /^\d+$/.test(token)
  const chain = '[\\w$]+(?:\\.[\\w$]+)*'
  const opRe = /===|!==/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((match = opRe.exec(body))) {
    const opStart = match.index
    const opEnd = opStart + match[0].length
    const snippet = (): string =>
      body
        .slice(Math.max(0, opStart - 30), Math.min(body.length, opEnd + 30))
        .replace(/\s+/g, ' ')
        .trim()

    const lhsLast = lhsEndChar(body, opStart)
    const rhsLast = rhsEndChar(body, opEnd)
    if (lhsLast === ')' || lhsLast === '`' || rhsLast === ')' || rhsLast === '`') {
      violations.push(snippet())
      continue
    }

    const lhsChainMatch = new RegExp(`(${chain})\\s*$`).exec(body.slice(0, opStart))
    const rhsChainMatch = new RegExp(`^\\s*(${chain})`).exec(body.slice(opEnd))
    const lhsToken = lhsChainMatch?.[1] ?? ''
    const rhsToken = rhsChainMatch?.[1] ?? ''
    if (!(isSafeOperand(lhsToken) || isSafeOperand(rhsToken))) {
      violations.push(snippet())
    }
  }
  return violations
}

/**
 * True when `timingSafeEqual(` is reachable from a `return` or an assignment
 * (`=`, not `==`/`===`/`!==`) through an unbroken chain of continuation
 * lines: every line between the anchor and the call — other than the one the
 * call itself starts on — must end, once trimmed, in `&&`, `||` or `=`. This
 * is what a multi-line `return`/assignment actually looks like in this
 * tree's own style, and it is what a `timingSafeEqual(...)` written as its
 * own statement, with the result thrown away, is not: the line before it
 * ends in whatever the previous statement ended in, not a continuation
 * token, so the chain breaks at the first line boundary even though a
 * `return` appears earlier in the body.
 */
function usesTimingSafeEqualAsReturnedOrAssigned(strippedBody: string): boolean {
  const anchorRe = /\breturn\b|[\w$]+\s*=(?!=)/g
  let anchor: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((anchor = anchorRe.exec(strippedBody))) {
    const anchorEnd = anchor.index + anchor[0].length
    const callIndex = strippedBody.indexOf('timingSafeEqual(', anchorEnd)
    if (callIndex === -1) continue
    const between = strippedBody.slice(anchorEnd, callIndex)
    const linesBeforeCall = between
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.trim().length > 0)
    const chained = linesBeforeCall.every((line) => /(?:&&|\|\||=)\s*$/.test(line.trimEnd()))
    if (chained) return true
  }
  return false
}

describe('crypto hygiene in secrets.ts and totp.ts', () => {
  const files = GATED_FILES.map((name) => ({
    name,
    source: readFileSync(join(here, name), 'utf8'),
  }))

  it('never seeds randomness with Math.random', () => {
    for (const { name, source } of files) {
      expect(stripComments(source).includes('Math.random'), name).toBe(false)
    }
  })

  it('uses timingSafeEqual somewhere in the file', () => {
    for (const { name, source } of files) {
      expect(stripComments(source).includes('timingSafeEqual('), name).toBe(true)
    }
  })

  it('decides a match, inside the gated function, only with timingSafeEqual', () => {
    for (const { name, source } of files) {
      const fnName = GATED_FUNCTIONS[name] as string
      const body = stripComments(extractFunctionBody(source, fnName))
      const label = `${name}#${fnName}`
      expect(usesTimingSafeEqualAsReturnedOrAssigned(body), label).toBe(true)
      expect(findDisallowedComparisons(body), label).toEqual([])
    }
  })
})
