/**
 * A gate on the source of every file in this package that could compare a
 * secret.
 *
 * This is the first secret comparison to live in the redirect, and the only one
 * an anonymous visitor drives: the proof cookie on a password-protected link is
 * checked on every request to that link, by whoever asks. The equivalent gates
 * over the credential primitives and the admin service do not travel — each
 * reads the source of its own package and nothing else — so a `===` written
 * here would be invisible to both. And "this compared in constant time" is not
 * observable by calling the function: the answer is the same either way, only
 * the time taken differs. This reads the source text instead, and fails at the
 * commit that introduces the regression rather than waiting on a measurement.
 *
 * **It follows the imports.** A comparison moved one file sideways is ordinary
 * refactoring, not an attack, so asking which functions call a primitive gates
 * the wrong thing. Instead: start from every file that imports one of the
 * primitives below, follow its relative imports transitively, and scan every
 * one of those files whole. A helper split out of a gated file is gated by the
 * act of importing it, and scanning whole files covers an arrow function, a
 * class method or a module-level expression, none of which a "find the function
 * declarations" pass sees.
 *
 * **What it requires of a comparison of secret material:** `timingSafeEqual`,
 * with a length check in front of it — that function throws on a length
 * mismatch, and a cookie is whatever the browser chose to send, so without the
 * length check a mangled proof is a 500 rather than a refusal.
 *
 * **Holes that remain**, stated rather than implied:
 *
 * - It reads text, not semantics. A comparison that avoids `==`, `!=` and
 *   `.equals(` — bitwise work on two buffers, a hand-rolled loop, a comparison
 *   method this file has never heard of — is invisible to it. So is a `switch`
 *   on a signature with the expected value as a `case`, which compares exactly
 *   as early-exitingly and contains no operator to find.
 * - It does not prove the comparison it finds runs in constant time, only that
 *   the source calls the function this codebase uses for that.
 * - It follows relative imports for their *values*. A type-only import names
 *   nothing that exists at runtime, so no comparison can run through it, and
 *   following one would drag a module's whole import graph in on the strength
 *   of a borrowed interface. A side-effect import — `import './x.js'`, with no
 *   bindings and so no `from` — is not followed at all; nothing here imports
 *   that way, and a file that starts to is the moment to write it.
 * - It says nothing about randomness. Nothing in this package mints a
 *   credential: the visitor id is not a secret, and `Math.random` here is the
 *   seam the evaluator picks a weighted target with. A gate banning it would
 *   have to exempt that, which would teach nothing the primitives' own gate
 *   does not already say.
 * - `ALLOWED_COMPARISONS` exempts specific expressions by their exact text,
 *   each keyed to the file and the declared function it was granted for. Each
 *   is a comparison of something that is not secret. Keying is what makes the
 *   exemption narrow: the text alone would be an exemption anywhere in the
 *   package. An entry that no longer matches anything fails too, so the list
 *   cannot rot.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Importing one of these is what makes a file a starting point: the two
 * primitives this package's own comparisons are built from, and the two whose
 * output decides whether a visitor has answered a link's password.
 */
const CREDENTIAL_PRIMITIVES = new Set([
  'timingSafeEqual',
  'createHmac',
  'passwordFingerprint',
  'verifyPassword',
])

/**
 * A floor under discovery: if a refactor stops one of these being reached, the
 * gate covers less than it did and someone has to look, rather than passing
 * over a smaller set. Add to it when a module joins; never trim it to pass.
 */
const EXPECTED_GATED_FILES = ['app.ts', 'password.ts', 'visitor.ts']

interface Exemption {
  file: string
  fn: string
  expression: string
  because: string
}

const ALLOWED_COMPARISONS: Exemption[] = [
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
]

/** Removes line and block comments, so dead text is never read as live code. */
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
    out.push(relative(here, full))
  }
  return out.sort()
}

const read = (file: string): string => stripComments(readFileSync(join(here, file), 'utf8'))

/**
 * The names a file imports from another package or from Node, `type`
 * specifiers dropped. Both sources matter here: two of the primitives come
 * from `node:crypto` and two from the core package.
 */
function importedNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^'.][^']*)'/g)) {
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
 * names them. A statement starts at the beginning of a line or after a `;`, so
 * a re-export — which carries no `import` keyword of its own — is classified by
 * where its own statement starts rather than by whatever precedes it.
 */
function localImports(file: string, source: string): string[] {
  const from = dirname(join(here, file))
  const out: string[] = []
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
 * import, transitively.
 */
function gatedFiles(): string[] {
  const all = new Set(sourceFiles())
  const queue = [...all].filter((f) =>
    importedNames(read(f)).some((n) => CREDENTIAL_PRIMITIVES.has(n)),
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

/**
 * Where an operand stops, scanning outward from the operator. `?` is in it for
 * a ternary, but `?.` is an optional chain in the middle of one whole value, so
 * a `?` immediately before a `.` is not a boundary.
 */
const BOUNDARY = /[(){}[\];,\n?:]/
const optionalChain = (text: string, i: number): boolean => text[i] === '?' && text[i + 1] === '.'

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
    if (depth === 0 && BOUNDARY.test(ch) && !optionalChain(text, i)) break
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
    // `=` and `!` end an operand, and so do `<` and `>`: a relational operator
    // binds tighter than equality, and `>` is also the tail of an arrow, which
    // would otherwise be read as part of the operand after its `=` stopped the
    // scan.
    if (depth === 0 && (ch === '=' || ch === '!' || ch === '<' || ch === '>')) break
    if (depth === 0 && BOUNDARY.test(ch) && !optionalChain(text, i)) break
  }
  return text.slice(i + 1, opStart).trim()
}

/**
 * Equality inside a gated file is not banned outright: this code legitimately
 * compares a value to `null`, a length to a number, a flag to `false` or a tag
 * to a string literal, long before it reaches any secret. Neither operand there
 * is the thing being verified, and a literal written in the source cannot be a
 * signature the browser sent. `typeof x` is a whole value too: it yields one of
 * a handful of fixed words, never secret material.
 *
 * Loose `==` and `!=` are matched as well as the strict pair: they compare just
 * as early-exitingly, and a "tidy up" that drops a character must not walk out
 * of the gate.
 *
 * Banned regardless of what is on the other side: `.equals(`, which has no
 * legitimate use here; an operand that is a call or template result, which
 * routes the comparison around whatever it looks like as plain text; and an
 * operand that is an expression rather than one whole value, since
 * `given === '' + want` is a concatenation whose first piece is an
 * innocent-looking literal.
 */
function findDisallowedComparisons(body: string): Comparison[] {
  const violations: Comparison[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) {
    violations.push({ expression: match[0], why: 'compares with .equals(', at: match.index })
  }

  const isWholeValue = (token: string): boolean =>
    /^(?:typeof\s+)?[\w$]+(?:\??\.[\w$]+)*$/.test(token) ||
    /^(['"]).*\1$/.test(token) ||
    /^-?\d+$/.test(token)
  const isSafeOperand = (token: string): boolean =>
    isWholeValue(token) &&
    (token === 'null' ||
      token === 'undefined' ||
      token === 'true' ||
      token === 'false' ||
      /^typeof\s/.test(token) ||
      /\.length$/.test(token) ||
      /^-?\d+$/.test(token) ||
      /^(['"]).*\1$/.test(token))

  const opRe = /!==|===|!=|==/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((match = opRe.exec(body))) {
    const op = match[0]
    // A keyword in front of the operand is not part of it: `return a === 1`
    // compares `a`, not `return a`. `typeof` is left in place, because there it
    // is the value being compared.
    const lhs = lhsText(body, match.index)
      .replace(/\s+/g, ' ')
      .replace(/^(?:return|case|yield|await|throw)\s+/, '')
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
 * Why a body's use of `timingSafeEqual(` does not decide anything, or the empty
 * string when it does.
 *
 * Three things have to hold. The call must be **returned or assigned** — one
 * written as its own statement with the result thrown away decides nothing, and
 * the line before it ends in whatever the previous statement ended in, so the
 * continuation chain breaks at the first line boundary even though a `return`
 * appears earlier in the body. When it is assigned, the name must be **read
 * again afterwards**, or the result is computed into a variable nothing looks
 * at. And the **two lengths must be compared to each other first**:
 * `timingSafeEqual` throws on a length mismatch, so without that a value of the
 * wrong length is a 500 rather than a refusal. The comparison has to be an
 * equality one between two `.length`s — a bound on one length, which both call
 * sites here also have, does not stop the two from differing, and counting it
 * let the real check be deleted with this gate still green.
 *
 * "Returned or assigned" includes an `if` or `while` condition, which is how
 * both call sites in this package are written — `if (a.length !== b.length ||
 * !timingSafeEqual(a, b)) return false`. A call written as its own statement,
 * with the result thrown away, is still rejected: the anchor before it is some
 * earlier statement, and the line between them does not end in a continuation
 * token, so the chain breaks at the first line boundary.
 */
function whyTimingSafeEqualDoesNotDecide(strippedBody: string): string {
  const callIndex = strippedBody.indexOf('timingSafeEqual(')
  if (callIndex === -1) return 'timingSafeEqual is not called here'
  const lengthCheck = /\.length\s*(?:!==|===|!=|==)\s*[\w$]+(?:\.[\w$]+)*\.length/.exec(
    strippedBody.slice(0, callIndex),
  )
  if (!lengthCheck) return 'the two lengths are not compared before timingSafeEqual is called'
  const anchorRe =
    /\breturn\b|\bif\s*\(|\bwhile\s*\(|(?:const|let|var)\s+([\w$]+)\s*=(?!=)|([\w$]+)\s*=(?!=)/g
  let anchor: RegExpExecArray | null
  let sawUnread = false
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((anchor = anchorRe.exec(strippedBody))) {
    const anchorEnd = anchor.index + anchor[0].length
    const call = strippedBody.indexOf('timingSafeEqual(', anchorEnd)
    if (call === -1) continue
    const linesBeforeCall = strippedBody
      .slice(anchorEnd, call)
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.trim().length > 0)
    if (!linesBeforeCall.every((line) => /(?:&&|\|\||=)\s*$/.test(line.trimEnd()))) continue
    const assignedTo = anchor[1] ?? anchor[2]
    if (assignedTo === undefined) return ''
    if (new RegExp(`\\b${assignedTo}\\b`).test(strippedBody.slice(call))) return ''
    sawUnread = true
  }
  return sawUnread
    ? 'timingSafeEqual is assigned to a name nothing reads afterwards'
    : 'timingSafeEqual is neither returned nor assigned'
}

describe('crypto hygiene in the redirect', () => {
  const gated = gatedFiles()

  it('gates every file that can reach a credential primitive', () => {
    // A superset: following the imports may find more than this, never less.
    expect(gated).toEqual(expect.arrayContaining(EXPECTED_GATED_FILES))
  })

  it('classifies a re-export by its own statement, not the one above it', () => {
    const reExport = "export { compare } from './helper.js'\n"
    expect(localImports('app.ts', `import type { Snapshot } from './snapshot.js'\n${reExport}`)) //
      .toEqual(['helper.ts'])
    expect(localImports('app.ts', `import { readVisitor } from './visitor.js'\n${reExport}`)) //
      .toEqual(['visitor.ts', 'helper.ts'])
    expect(localImports('app.ts', "export type { Shape } from './helper.js'\n")).toEqual([])
    // A module specifier that is not relative is not mistaken for the next
    // statement's, whichever kind of statement follows it.
    expect(localImports('app.ts', `import Fastify from 'fastify'\n${reExport}`)).toEqual([
      'helper.ts',
    ])
  })

  it('compares a secret, in every gated file, only with timingSafeEqual', () => {
    for (const file of gated) {
      // An exemption applies in the one file and function it was granted for,
      // and nowhere else. And only while that name means one function: a second
      // declaration of it would otherwise inherit the exemption, so an
      // exemption over a duplicated name applies nowhere.
      const declared = functionBodies(read(file)).map((fn) => fn.name)
      const exempt = new Set(
        ALLOWED_COMPARISONS.filter(
          (a) => a.file === file && declared.filter((n) => n === a.fn).length === 1,
        ).map((a) => `${a.fn}: ${a.expression}`),
      )
      expect(
        comparisonsIn(file).filter((c) => !exempt.has(`${c.fn}: ${c.expression}`)),
        file,
      ).toEqual([])
    }
  })

  it('has no exemption that stopped matching anything', () => {
    for (const { file, fn, expression, because } of ALLOWED_COMPARISONS) {
      // A file that has left the gate fails here too: an exemption over
      // unscanned source exempts nothing and hides that it stopped applying.
      const found = gated.includes(file)
        ? comparisonsIn(file).map((c) => `${c.fn}: ${c.expression}`)
        : []
      expect(found, `${file}#${fn} ${expression} (${because})`).toContain(`${fn}: ${expression}`)
    }
  })

  it('lets the result of timingSafeEqual decide the answer, file by file', () => {
    // Per file, not one count over the package: a single call anywhere would
    // otherwise let a throwaway helper cover for the file whose comparison had
    // been taken out.
    //
    // A file counts as a comparer because it *imports* the primitive, not
    // because its text happens to call it: keyed on the call, a file whose
    // comparison was deleted outright simply left the set, and the other file's
    // call covered for it.
    const comparers = gated.filter((file) => importedNames(read(file)).includes('timingSafeEqual'))
    // And a floor under that: this package compares a signature somewhere.
    expect(comparers.length).toBeGreaterThan(0)
    for (const file of comparers) {
      const subjects = functionBodies(read(file)).filter((fn) =>
        fn.body.includes('timingSafeEqual('),
      )
      // A file that calls it must do so where the answer turns on it.
      expect(subjects.length, file).toBeGreaterThan(0)
      for (const fn of subjects) {
        expect(whyTimingSafeEqualDoesNotDecide(fn.body), `${file}#${fn.name}`).toBe('')
      }
    }
  })
})
