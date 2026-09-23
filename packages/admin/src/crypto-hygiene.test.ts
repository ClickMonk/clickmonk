/**
 * A gate on the source of every file in this package that could compare a
 * credential.
 *
 * It is here because the equivalent gate over the credential primitives does
 * not travel: it reads the source of its own package's files and nothing else,
 * so a `===` written here would be invisible to it. And "this compared in
 * constant time" is not observable by calling the function — the answer is the
 * same either way, only the time taken differs — so a behavioural test cannot
 * pin it. This reads the source text instead, and fails at the commit that
 * introduces the regression rather than waiting on a measurement.
 *
 * **It follows the imports.** Earlier versions asked which functions called a
 * credential primitive, which meant a comparison moved one file sideways —
 * `compare.ts` holding `a === b`, called from `authenticateKey` — was gated by
 * nothing, and that is ordinary refactoring rather than an attack. Instead:
 * start from every file that imports a credential primitive from the core
 * package, follow its relative imports transitively, and scan **every one of
 * those files whole**. A helper split out of a gated file is gated by the act
 * of importing it.
 *
 * Scanning whole files rather than selected functions also means an arrow
 * function, a class method or a module-level expression is covered, none of
 * which a "find the function declarations" pass sees.
 *
 * **Holes that remain**, stated rather than implied:
 *
 * - It reads text, not semantics. A comparison that avoids `==`, `!=` and
 *   `.equals(` — bitwise work on two buffers, a hand-rolled loop, a comparison
 *   method this file has never heard of — is invisible to it.
 * - It does not prove the comparison it finds runs in constant time, only that
 *   the source calls the function this codebase uses for that.
 * - A comparison written without a comparison operator at all is invisible:
 *   most sharply, a `switch` on a digest with the stored value as a `case`,
 *   which compares exactly as early-exitingly as `===` and contains no `==`,
 *   `!=` or `.equals(` for this file to find.
 * - It follows relative imports **for their values**. A comparison moved into
 *   another workspace package, or reached through a dynamic `import()`, is
 *   outside its reach — though a new package holding credential logic would
 *   need its own gate anyway, which is the same reason this one exists. A
 *   type-only import is not followed either: it names nothing that exists at
 *   runtime, so no comparison can run through it, and importing a type from a
 *   module must not drag that module's whole import graph into the gate. A
 *   module a gated file imports for a *value* is gated as it always was.
 * - A side-effect import — `import './x.js'`, with no bindings and so no
 *   `from` — is not followed at all, and never has been. The module it runs
 *   could hold a comparison at its top level. Closing it means matching a
 *   second statement shape rather than adjusting the one below, so it is
 *   recorded here instead: nothing in this package imports that way, and a
 *   file that starts to is the moment to write it.
 * - `ALLOWED_COMPARISONS` below exempts specific expressions by their exact
 *   text, **each keyed to the file and the declared function it was granted
 *   for**. Each is a comparison of something that is not secret. Keying is what
 *   makes the exemption narrow: without it the text alone was the exemption
 *   anywhere in the package, so spelling a secret comparison the way an exempt
 *   one is spelled — in another file, in another function — passed the gate.
 *   A secret comparison added beside an exempt one still fails, and an entry
 *   that no longer matches anything fails too, so the list cannot rot. An
 *   exemption applies only while its function name means one function in that
 *   file: a second declaration of the name would otherwise borrow it.
 * - `digestsMatch`'s result is traced from `return` and assignment through
 *   continuation lines. A result routed through a data structure, or through a
 *   second function, is not followed.
 *
 * A session token is not compared in JavaScript anywhere in this package: its
 * digest is the indexed key its row is found by, so the comparison is
 * Postgres's, against a fixed-width digest, and there is no branch here that
 * could return early on a differing byte.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Importing one of these is what makes a file a starting point. They are the
 * primitives whose output is compared *in this process*: a digest to check, the
 * comparison itself, the parse that splits a presented key, and the mint that
 * produces the value on the other side of one. Password and one-time-code
 * verification are not here because they never return something this package
 * compares — the comparison happens inside the core package, which has its own
 * gate over exactly that.
 */
const CREDENTIAL_PRIMITIVES = new Set([
  'digestsMatch',
  'hashToken',
  'parseApiKey',
  'newOpaqueToken',
  'newApiKey',
])

/**
 * A floor under discovery: if a refactor stops this file being reached, the
 * gate covers less than it did and someone has to look, rather than passing
 * over an empty set. Add to it when a module joins; never trim it to pass.
 */
const EXPECTED_GATED_FILES = ['auth.ts', 'http.ts', 'keys.ts']

/**
 * Comparisons of things that are not secret, exempt by exact text in exactly
 * one file and one declared function. Every entry must still match something
 * there, so a stale exemption is a failure. `(module)` is the name for an
 * expression that sits outside any declared function.
 */
interface Exemption {
  file: string
  fn: string
  expression: string
  because: string
}

const ALLOWED_COMPARISONS: Exemption[] = [
  {
    file: 'auth.ts',
    fn: 'checkCsrf',
    expression: 'o.origin !== expected',
    because:
      'the cross-site write guard compares a request header to the admin origin; ' +
      'neither is secret, and the answer is the same to everyone',
  },
]

/**
 * Removes line and block comments, so a check further down never counts dead,
 * commented-out text as evidence that live code does something.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every source file in the package and its subdirectories, as relative paths. */
function sourceFiles(dir = here): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    if (entry.name === 'testing.ts') continue
    out.push(relative(here, full))
  }
  return out.sort()
}

const read = (file: string): string => stripComments(readFileSync(join(here, file), 'utf8'))

/** The names a file imports from the core package, `type` specifiers dropped. */
function coreImports(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@clickmonk\/core'/g)) {
    for (const part of (match[1] as string).split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/**
 * The package-relative files a file imports **for a value**, as `sourceFiles()`
 * names them.
 *
 * A statement starts at the beginning of a line or after a `;`, so a second
 * statement sharing a line is read as its own rather than being swallowed by
 * the first.
 *
 * A type-only import — `import type { X } from './x.js'`, or a clause whose
 * every specifier is `type`-prefixed — is left out. Nothing it names survives
 * compilation, so no comparison can be reached through it, and following one
 * would gate a module's entire import graph on the strength of a borrowed
 * interface. A module imported for a value from the same file is still gated.
 */
function localImports(file: string, source: string): string[] {
  const from = dirname(join(here, file))
  const out: string[] = []
  // Each statement is matched from its own start — an `import` or an `export`
  // at the beginning of a line — rather than by scanning backwards for the
  // nearest `import`. Backwards, a re-export (`export { x } from './x.js'`,
  // which has no `import` of its own) took the classification of whatever
  // statement happened to precede it, so the same line was followed or skipped
  // depending on what was above it. The clause may not contain a quote, which
  // is what stops a match running past its own module specifier into the next
  // statement's.
  for (const match of source.matchAll(
    /(?:^|;)[ \t]*(?:import|export)\b([^'"]*?)\bfrom\s*'(\.[^']*)'/gm,
  )) {
    const clause = match[1] as string
    const specifiers = clause
      .replace(/[{}]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const typeOnly =
      /^\s*type\b/.test(clause) ||
      (specifiers.length > 0 && specifiers.every((s) => /^type\b/.test(s)))
    if (typeOnly) continue
    const target = resolve(from, (match[2] as string).replace(/\.js$/, '.ts'))
    out.push(relative(here, target))
  }
  return out
}

/**
 * Every file that imports a credential primitive, plus everything those files
 * import, transitively. A helper is gated because something gated reaches it.
 */
function gatedFiles(): string[] {
  const all = new Set(sourceFiles())
  const queue = [...all].filter((f) =>
    coreImports(read(f)).some((n) => CREDENTIAL_PRIMITIVES.has(n)),
  )
  const gated = new Set(queue)
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const next of localImports(file, read(file))) {
      if (!all.has(next) || gated.has(next)) continue
      gated.add(next)
      queue.push(next)
    }
  }
  return [...gated].sort()
}

interface Comparison {
  /** The whole expression, whitespace collapsed: what an exemption names. */
  expression: string
  why: string
  /** Where it sits in the file, so it can be attributed to a function. */
  at: number
}

/** Where an operand stops, scanning outward from the operator. */
const BOUNDARY = /[(){}[\];,\n?:]/

/**
 * The operand to the right of an operator, as raw text. Its extent has to be
 * found by scanning: a call has its own balanced parentheses, so it does not
 * end at the first `)` — it ends at the `)` that returns depth to zero, or at
 * `&&`, `||`, `;`, `,` or a newline at depth zero, whichever comes first.
 */
function rhsText(text: string, opEnd: number): string {
  let i = opEnd
  let depth = 0
  const start = i
  for (; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '(' || ch === '[') {
      depth++
      continue
    }
    if (ch === ')' || ch === ']') {
      if (depth === 0) break
      depth--
      continue
    }
    if (depth === 0 && (text.startsWith('&&', i) || text.startsWith('||', i))) break
    if (depth === 0 && BOUNDARY.test(ch)) break
  }
  return text.slice(start, i).trim()
}

/** The operand to the left, by the mirrored rules. */
function lhsText(text: string, opStart: number): string {
  let i = opStart - 1
  let depth = 0
  for (; i >= 0; i--) {
    const ch = text[i] as string
    if (ch === ')' || ch === ']') {
      depth++
      continue
    }
    if (ch === '(' || ch === '[') {
      if (depth === 0) break
      depth--
      continue
    }
    if (depth === 0 && (text.startsWith('&&', i - 1) || text.startsWith('||', i - 1))) break
    if (depth === 0 && (ch === '=' || ch === '!')) break
    if (depth === 0 && BOUNDARY.test(ch)) break
  }
  return text.slice(i + 1, opStart).trim()
}

/**
 * Equality inside a gated file is not banned outright: this code legitimately
 * compares a value to `null` or `undefined`, a length to a number, or a tag to
 * a string literal, long before it reaches any secret. Neither operand there is
 * the thing being verified, and a literal written in the source cannot be a
 * stored digest.
 *
 * Loose `==` and `!=` are matched as well as the strict pair: they compare just
 * as early-exitingly, and a "tidy up" that drops a character must not walk out
 * of the gate.
 *
 * Banned regardless of what is on the other side: `.equals(`, which has no
 * legitimate use here; an operand that is a call or template result, which
 * routes the comparison around whatever it looks like as plain text
 * (`hashToken(x) === row.secret_hash` compares strings built from the secret
 * material); and an operand that is an expression rather than one whole value —
 * `presented === '' + stored` is a concatenation whose first piece is an
 * innocent-looking literal.
 */
function findDisallowedComparisons(body: string): Comparison[] {
  const violations: Comparison[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) {
    violations.push({ expression: match[0], why: 'compares with .equals(', at: match.index })
  }

  const isWholeValue = (token: string): boolean =>
    /^[\w$]+(?:\.[\w$]+)*$/.test(token) || /^(['"]).*\1$/.test(token) || /^-?\d+$/.test(token)
  const isSafeOperand = (token: string): boolean =>
    isWholeValue(token) &&
    (token === 'null' ||
      token === 'undefined' ||
      /\.length$/.test(token) ||
      /^-?\d+$/.test(token) ||
      /^(['"]).*\1$/.test(token))

  const opRe = /!==|===|!=|==/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((match = opRe.exec(body))) {
    const op = match[0]
    const lhs = lhsText(body, match.index).replace(/\s+/g, ' ')
    const rhs = rhsText(body, match.index + op.length).replace(/\s+/g, ' ')
    const expression = `${lhs} ${op} ${rhs}`.trim()
    const at = match.index
    if (lhs.endsWith(')') || lhs.endsWith('`') || rhs.endsWith(')') || rhs.endsWith('`')) {
      violations.push({ expression, why: 'an operand is a call or template result', at })
      continue
    }
    if (!isWholeValue(lhs) || !isWholeValue(rhs)) {
      violations.push({ expression, why: 'an operand is an expression, not one whole value', at })
      continue
    }
    if (!(isSafeOperand(lhs) || isSafeOperand(rhs))) {
      violations.push({ expression, why: 'neither operand is a literal, a length or null', at })
    }
  }
  return violations
}

interface FunctionBody {
  name: string
  body: string
  /** The extent of the body in the file, so an expression can be placed in it. */
  start: number
  end: number
}

/**
 * Every declared function in a file, with its body, found by brace-balance from
 * the declaration rather than by "the first `{` after the name": a parameter may
 * itself be an inline object type, whose `{` comes first.
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
          out.push({
            name: match[1] as string,
            body: source.slice(openBrace, j + 1),
            start: openBrace,
            end: j + 1,
          })
          break
        }
      }
    }
  }
  return out
}

/** The name an expression is exempted under: its innermost declared function. */
const MODULE_LEVEL = '(module)'

/**
 * The innermost declared function containing an offset, or `(module)`. Innermost
 * by extent, so a helper declared inside another function is named rather than
 * its parent — an exemption granted to the outer one must not cover it.
 */
function enclosingFunction(functions: FunctionBody[], at: number): string {
  let name = MODULE_LEVEL
  let narrowest = Number.POSITIVE_INFINITY
  for (const fn of functions) {
    const width = fn.end - fn.start
    if (at >= fn.start && at < fn.end && width < narrowest) {
      name = fn.name
      narrowest = width
    }
  }
  return name
}

/** Every disallowed comparison in a file, each named by the function it sits in. */
function comparisonsIn(file: string): { fn: string; expression: string; why: string }[] {
  const source = read(file)
  const functions = functionBodies(source)
  return findDisallowedComparisons(source).map((c) => ({
    fn: enclosingFunction(functions, c.at),
    expression: c.expression,
    why: c.why,
  }))
}

/**
 * Why a body's use of `digestsMatch(` does not decide anything, or the empty
 * string when it does.
 *
 * Two things have to hold. The call must be **returned or assigned** — one
 * written as its own statement with the result thrown away decides nothing, and
 * the line before it ends in whatever the previous statement ended in, so the
 * continuation chain breaks at the first line boundary even though a `return`
 * appears earlier in the body. And when it is assigned, the name must be
 * **read again afterwards**: a result computed into a variable nothing goes on
 * to look at decides nothing either, which is exactly what deleting the name
 * from the condition below it leaves behind.
 */
function whyDigestsMatchDoesNotDecide(strippedBody: string): string {
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
    if (assignedTo === undefined) return ''
    const rest = strippedBody.slice(callIndex)
    if (new RegExp(`\\b${assignedTo}\\b`).test(rest)) return ''
    sawUnread = true
  }
  return sawUnread
    ? 'digestsMatch is assigned to a name nothing reads afterwards'
    : 'digestsMatch is neither returned nor assigned'
}

describe('crypto hygiene in the admin service', () => {
  const gated = gatedFiles()

  it('never reaches for Math.random', () => {
    // Nothing in this package has a use for a non-cryptographic random number,
    // and one file here mints a throwaway password hash that a sign-in against
    // an unknown address is measured against.
    for (const file of sourceFiles()) {
      expect(read(file).includes('Math.random'), file).toBe(false)
    }
  })

  it('gates every file that can reach a credential primitive', () => {
    // A superset: following the imports may find more than this, never less.
    expect(gated).toEqual(expect.arrayContaining(EXPECTED_GATED_FILES))
  })

  /**
   * A re-export carries no `import` keyword of its own, so which statement it
   * belongs to has to be decided by where that statement starts. Both
   * positions are checked: a re-export is followed whatever sits above it, and
   * only its own `type` keyword takes it out of the gate.
   */
  it('classifies a re-export by its own statement, not the one above it', () => {
    const reExport = "export { compare } from './helper.js'\n"
    expect(localImports('keys.ts', `import type { AdminContext } from './app.js'\n${reExport}`)) //
      .toEqual(['helper.ts'])
    expect(localImports('keys.ts', `import { requireSession } from './auth.js'\n${reExport}`)) //
      .toEqual(['auth.ts', 'helper.ts'])
    expect(localImports('keys.ts', "export type { Shape } from './helper.js'\n")).toEqual([])
    // A module specifier that is not relative is not mistaken for the next
    // statement's, whichever kind of statement follows it.
    expect(localImports('keys.ts', `import { z } from 'zod'\n${reExport}`)).toEqual(['helper.ts'])
    // And a statement that shares a line with the one before it is still its
    // own. The formatter would split these, so this is not a shape that
    // survives a commit — but the parser must not depend on the formatter.
    expect(localImports('keys.ts', `import type { A } from './app.js'; ${reExport}`)) //
      .toEqual(['helper.ts'])
  })

  it('compares a credential, in every gated file, only with digestsMatch', () => {
    for (const file of gated) {
      // An exemption applies in the one file and function it was granted for,
      // and nowhere else: the same text elsewhere is an unexempted comparison.
      //
      // And only while that name means one function. A second declaration of
      // the same name — a nested helper shadowing it, say — would otherwise
      // inherit the exemption, so an exemption over a duplicated name applies
      // nowhere and the file fails until the names are distinct again.
      const declared = functionBodies(read(file)).map((fn) => fn.name)
      const exempt = new Set(
        ALLOWED_COMPARISONS.filter(
          (a) => a.file === file && declared.filter((n) => n === a.fn).length === 1,
        ).map((a) => `${a.fn}: ${a.expression}`),
      )
      const found = comparisonsIn(file)
      expect(
        found.filter((c) => !exempt.has(`${c.fn}: ${c.expression}`)),
        file,
      ).toEqual([])
    }
  })

  it('has no exemption that stopped matching anything', () => {
    for (const { file, fn, expression, because } of ALLOWED_COMPARISONS) {
      const found = gated.includes(file)
        ? comparisonsIn(file).map((c) => `${c.fn}: ${c.expression}`)
        : []
      // A file that has left the gate fails here too: an exemption over
      // unscanned source exempts nothing and hides that it stopped applying.
      expect(found, `${file}#${fn} ${expression} (${because})`).toContain(`${fn}: ${expression}`)
    }
  })

  it('lets the result of digestsMatch decide the answer, file by file', () => {
    // Per file, not one count over the package: a single call anywhere used to
    // satisfy this, so a throwaway helper elsewhere covered for the file whose
    // comparison had been taken out.
    const comparers = gated.filter((file) => coreImports(read(file)).includes('digestsMatch'))
    // And a floor under that: the package compares a digest somewhere.
    expect(comparers.length).toBeGreaterThan(0)
    for (const file of gated) {
      const subjects = functionBodies(read(file))
        .filter((fn) => fn.body.includes('digestsMatch('))
        .map((fn) => ({ label: `${file}#${fn.name}`, body: fn.body }))
      // A file that imports it must call it where the answer turns on it.
      if (comparers.includes(file)) expect(subjects.length, file).toBeGreaterThan(0)
      for (const { label, body } of subjects) {
        expect(whyDigestsMatchDoesNotDecide(body), label).toBe('')
      }
    }
  })
})
