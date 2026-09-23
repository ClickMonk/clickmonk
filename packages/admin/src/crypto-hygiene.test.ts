/**
 * A gate on every function in this package that decides whether a presented
 * secret matches a stored one.
 *
 * It is here because the equivalent gate over the credential primitives does
 * not travel: it reads the source of its own package's files and nothing else,
 * so a `===` written here would be invisible to it. And "this compared in
 * constant time" is not observable by calling the function — the answer is the
 * same either way, only the time taken differs — so a behavioural test cannot
 * pin it. This reads the source text instead, and fails at the commit that
 * introduces the regression rather than waiting on a measurement.
 *
 * **It finds its own subjects.** An earlier version named the one function it
 * gated, which meant a file added later was simply not covered and nothing
 * said so. This instead walks every non-test source file in the package and
 * gates every function whose body calls `hashToken(` or `digestsMatch(` — the
 * two calls that turn a presented credential into something comparable and
 * compare it. A new module that authenticates a key is gated the moment it is
 * written, without anyone remembering to add it; and `EXPECTED_SUBJECTS` below
 * fails if the discovery itself stops finding what it found before, so a
 * rename that empties the gate is a failure rather than a silent pass.
 *
 * Functions that compare something which is not a secret are deliberately out
 * of scope — the cross-site `Origin` check compares two strings with `!==` and
 * should, since neither is secret and the answer is public either way.
 *
 * A session token is not compared in JavaScript anywhere in this package: its
 * digest is the indexed key its row is found by, so the comparison is
 * Postgres's, against a fixed-width digest, and there is no branch here that
 * could return early on a differing byte.
 *
 * What this is, and is not: a tripwire for a careless edit — a rename, a
 * "simplify this" pass, a copy-paste from the wrong function — not a proof
 * against a determined author. It reads text, not semantics, so a hand-rolled
 * byte loop is invisible to it, and it does not prove the comparison it finds
 * actually runs in constant time, only that the source calls the function this
 * codebase uses for that.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** The calls that mark a function as deciding whether a credential matches. */
const CREDENTIAL_CALLS = ['hashToken(', 'digestsMatch(']

/**
 * What discovery must find. Not the gate's input — the gate reads the
 * directory — but a floor under it: if a refactor moves or renames these, this
 * list fails and someone has to look, rather than the gate quietly covering
 * nothing. Add to it when a module joins; never trim it to make it pass.
 */
const EXPECTED_SUBJECTS = ['auth.ts#authenticateKey']

/**
 * Removes line and block comments, so a check further down never counts dead,
 * commented-out text as evidence that live code does something.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every non-test source file in the package, excluding the test helper. */
function sourceFiles(): string[] {
  return readdirSync(here)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'testing.ts')
    .sort()
}

interface FunctionBody {
  name: string
  body: string
}

/**
 * Every named function in a file, with its body, found by brace-balance from
 * each declaration rather than by "the first `{` after the name": a parameter
 * may itself be an inline object type, whose `{` comes first. Parentheses are
 * balanced to the end of the parameter list, then braces from the first `{`
 * after that.
 */
function functionBodies(source: string): FunctionBody[] {
  const out: FunctionBody[] = []
  const declaration = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((match = declaration.exec(source))) {
    let i = match.index + match[0].length - 1
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
    if (openBrace === -1) continue
    let braceDepth = 0
    for (let j = openBrace; j < source.length; j++) {
      if (source[j] === '{') braceDepth++
      else if (source[j] === '}') {
        braceDepth--
        if (braceDepth === 0) {
          out.push({ name: match[1] as string, body: source.slice(openBrace, j + 1) })
          break
        }
      }
    }
  }
  return out
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
 * Equality inside a gated body is not banned outright: these functions
 * legitimately compare a value to `null`, a length to a number, or a tag to a
 * string literal before they ever reach the secret material. Neither operand
 * there is the thing being verified, and a literal written in this file cannot
 * be a stored digest.
 *
 * Loose `==` and `!=` are matched as well as the strict pair: they compare
 * just as early-exitingly, and a "tidy up" that drops a character must not
 * walk out of the gate.
 *
 * Two things are banned regardless of what is on the other side. `.equals(`,
 * which has no legitimate use here. And a comparison where either operand ends
 * in `)` or a backtick: a call result or a template result, which routes the
 * comparison around whatever the operand looks like as plain text —
 * `hashToken(x) === row.secret_hash` compares strings built from the secret
 * material, and no identifier-based check can tell that from a length check.
 */
function findDisallowedComparisons(body: string): string[] {
  const violations: string[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) violations.push(match[0])

  const isSafeOperand = (token: string): boolean =>
    token === 'null' ||
    token === 'undefined' ||
    /\.length$/.test(token) ||
    /^-?\d+$/.test(token) ||
    /^(['"]).*\1$/.test(token)
  // A chain of identifiers, or a quoted string literal with no quote inside it.
  const operand = `(?:[\\w$]+(?:\\.[\\w$]+)*|'[^']*'|"[^"]*")`
  const opRe = /!==|===|!=|==/g
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

    const lhsToken = new RegExp(`(${operand})\\s*$`).exec(body.slice(0, opStart))?.[1] ?? ''
    const rhsToken = new RegExp(`^\\s*(${operand})`).exec(body.slice(opEnd))?.[1] ?? ''
    if (!(isSafeOperand(lhsToken) || isSafeOperand(rhsToken))) {
      violations.push(snippet())
    }
  }
  return violations
}

/**
 * Why a body's use of `digestsMatch(` does not count, or the empty string when
 * it does.
 *
 * Two things have to hold, and the second is the one an earlier version of
 * this gate missed. The call must be **returned or assigned** — a
 * `digestsMatch(...)` written as its own statement with the result thrown away
 * decides nothing, and the line before it ends in whatever the previous
 * statement ended in, so the continuation chain breaks at the first line
 * boundary even though a `return` appears earlier in the body. And when it is
 * assigned, the name it was assigned to must be **read again afterwards**: a
 * result computed into a variable that nothing goes on to look at decides
 * nothing either, which is exactly what deleting the name from the condition
 * below it leaves behind.
 */
function whyDigestsMatchDoesNotDecide(strippedBody: string): string {
  if (!strippedBody.includes('digestsMatch(')) return 'digestsMatch is never called'
  const anchorRe = /\breturn\b|(?:const|let|var)\s+([\w$]+)\s*=(?!=)|([\w$]+)\s*=(?!=)/g
  let anchor: RegExpExecArray | null
  let sawUnread = false
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
    if (!linesBeforeCall.every((line) => /(?:&&|\|\||=)\s*$/.test(line.trimEnd()))) continue
    const assignedTo = anchor[1] ?? anchor[2]
    if (assignedTo === undefined) return '' // returned directly
    // Assigned: the name has to be read somewhere after the assignment.
    const rest = strippedBody.slice(callIndex)
    if (new RegExp(`\\b${assignedTo}\\b`).test(rest)) return ''
    sawUnread = true
  }
  return sawUnread
    ? 'digestsMatch is assigned to a name nothing reads afterwards'
    : 'digestsMatch is neither returned nor assigned'
}

describe('crypto hygiene in the admin service', () => {
  const subjects = sourceFiles().flatMap((file) => {
    const source = readFileSync(join(here, file), 'utf8')
    return functionBodies(stripComments(source))
      .filter((fn) => CREDENTIAL_CALLS.some((call) => fn.body.includes(call)))
      .map((fn) => ({ label: `${file}#${fn.name}`, body: fn.body }))
  })

  // Nothing in this package has a use for a non-cryptographic random number,
  // and one file here mints a throwaway password hash that a sign-in against an
  // unknown address is measured against. `Math.random` is not a weakness in
  // that particular spot, but it is the wrong reach in a package about
  // credentials, and the next person to copy the line will be somewhere it is.
  it('never reaches for Math.random', () => {
    for (const file of sourceFiles()) {
      const source = stripComments(readFileSync(join(here, file), 'utf8'))
      expect(source.includes('Math.random'), file).toBe(false)
    }
  })

  it('finds every function that handles a presented credential', () => {
    const labels = subjects.map((s) => s.label)
    // A superset: discovery may find more than this, never less.
    expect(labels).toEqual(expect.arrayContaining(EXPECTED_SUBJECTS))
  })

  // Discovery reads `function` declarations. A file that reaches for a
  // credential call from an arrow function, or from anywhere else this cannot
  // see, would otherwise be gated by nothing at all and say nothing about it.
  it('leaves no file that handles a credential ungated', () => {
    for (const file of sourceFiles()) {
      const source = stripComments(readFileSync(join(here, file), 'utf8'))
      if (!CREDENTIAL_CALLS.some((call) => source.includes(call))) continue
      const gated = subjects.filter((s) => s.label.startsWith(`${file}#`))
      expect(
        gated.length,
        `${file} calls a credential primitive outside any gated function`,
      ).toBeGreaterThan(0)
      // And every one of those calls sits inside a function this gate read.
      for (const call of CREDENTIAL_CALLS) {
        const inSource = source.split(call).length - 1
        const inGated = gated.reduce((n, g) => n + g.body.split(call).length - 1, 0)
        expect(inGated, `${file}: ${call} outside a gated function`).toBe(inSource)
      }
    }
  })

  it('decides a match, inside every such function, only with digestsMatch', () => {
    for (const { label, body } of subjects) {
      expect(findDisallowedComparisons(body), label).toEqual([])
    }
  })

  it('lets the result of digestsMatch decide the answer wherever it is called', () => {
    for (const { label, body } of subjects.filter((s) => s.body.includes('digestsMatch('))) {
      expect(whyDigestsMatchDoesNotDecide(body), label).toBe('')
    }
  })
})
