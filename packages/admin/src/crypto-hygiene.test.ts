/**
 * A gate on the one function in this package that decides whether a presented
 * secret matches a stored one, `authenticateKey` in `auth.ts`.
 *
 * It is here because the equivalent gate over the credential primitives does
 * not travel: it reads the source of its own package's files and nothing
 * else, so a `===` written here would be invisible to it. And "this compared
 * in constant time" is not observable by calling the function — the answer is
 * the same either way, only the time taken differs — so a behavioural test
 * cannot pin it. This reads the source text instead, and fails at the commit
 * that introduces the regression rather than waiting on a measurement.
 *
 * Only the API key path is gated, because it is the only place in this
 * package that compares secret material in JavaScript. A session cookie is
 * not compared here at all: its digest is the indexed key its row is found
 * by, so the comparison is Postgres's, against a fixed-width digest, and
 * there is no branch here that could return early on a differing byte. If a
 * later change ever compares a session token in this process, it belongs in
 * `GATED_FUNCTIONS` below.
 *
 * What this is, and is not: a tripwire for a careless edit — a rename, a
 * "simplify this" pass, a copy-paste from the wrong function — not a proof
 * against a determined author. It reads text, not semantics, so a hand-rolled
 * byte loop is invisible to it, and it does not prove the comparison it finds
 * actually runs in constant time, only that the source calls the function
 * this codebase uses for that.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** The one function per file that decides whether a presented secret matches. */
const GATED_FUNCTIONS: { file: string; fn: string }[] = [{ file: 'auth.ts', fn: 'authenticateKey' }]

/**
 * Removes line and block comments, so a check further down never counts dead,
 * commented-out text as evidence that live code does something.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * One function's body, found by brace-balance from its declaration rather
 * than by "the first `{` after the name": a parameter may itself be an inline
 * object type, whose `{` comes first. Parentheses are balanced to the end of
 * the parameter list, then braces from the first `{` after that.
 */
function extractFunctionBody(source: string, name: string): string {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source)
  if (!declaration) throw new Error(`${name} not found`)
  let i = declaration.index + declaration[0].length - 1
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

/** The last non-whitespace character of the operand left of an operator. */
function lhsEndChar(text: string, opStart: number): string {
  let i = opStart - 1
  while (i >= 0 && /\s/.test(text[i] as string)) i--
  return i >= 0 ? (text[i] as string) : ''
}

/**
 * The last non-whitespace character of the operand right of an operator. The
 * right operand's extent has to be found by scanning forward: a call has its
 * own balanced parentheses, so it does not end at the first `)` — it ends at
 * the `)` that returns depth to zero, or at `&&`, `||`, `;`, `,` or a newline
 * at depth zero, whichever comes first.
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
 * `===`/`!==` inside a gated body are not banned outright: the function
 * legitimately compares a value to `null` or a length to a length before it
 * ever reaches the secret material. Neither operand there is the thing being
 * verified.
 *
 * Two things are banned regardless of what is on the other side. `.equals(`,
 * which has no legitimate use here. And a comparison where either operand
 * ends in `)` or a backtick: a call result or a template result, which routes
 * the comparison around whatever the operand looks like as plain text —
 * `hashToken(x) === row.secret_hash` compares strings built from the secret
 * material, and no identifier-based check can tell that from a length check.
 *
 * Anything else is allowed only when one side is `null`, a `.length` chain,
 * or a numeric literal.
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
 * True when `digestsMatch(` is reachable from a `return` or an assignment
 * (`=`, not `==`/`===`/`!==`) through an unbroken chain of continuation
 * lines: every line between the anchor and the call — other than the one the
 * call itself starts on — must end, once trimmed, in `&&`, `||` or `=`. A
 * `digestsMatch(...)` written as its own statement with the result thrown
 * away is not that: the line before it ends in whatever the previous
 * statement ended in, so the chain breaks at the first line boundary even
 * though a `return` appears earlier in the body.
 */
function usesDigestsMatchAsReturnedOrAssigned(strippedBody: string): boolean {
  const anchorRe = /\breturn\b|[\w$]+\s*=(?!=)/g
  let anchor: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((anchor = anchorRe.exec(strippedBody))) {
    const anchorEnd = anchor.index + anchor[0].length
    const callIndex = strippedBody.indexOf('digestsMatch(', anchorEnd)
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

describe('crypto hygiene in the admin service', () => {
  it('decides a secret matches, inside the gated function, only with digestsMatch', () => {
    for (const { file, fn } of GATED_FUNCTIONS) {
      const source = readFileSync(join(here, file), 'utf8')
      const body = stripComments(extractFunctionBody(source, fn))
      const label = `${file}#${fn}`
      expect(usesDigestsMatchAsReturnedOrAssigned(body), label).toBe(true)
      expect(findDisallowedComparisons(body), label).toEqual([])
    }
  })
})
