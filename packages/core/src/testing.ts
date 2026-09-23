/**
 * One crypto-hygiene checker, for every package that holds a secret
 * comparison.
 *
 * **Why it reads source text.** "This compared in constant time" is not
 * observable by calling the function: the answer is the same either way, only
 * the time taken differs. A behavioural test cannot pin it, so this reads the
 * source instead and fails at the commit that introduces a regression rather
 * than waiting on a measurement.
 *
 * **Why it is shared.** There were three copies — the credential primitives',
 * the admin service's and the redirect's. A gate reads its own package's files
 * and nothing else, so each package needs one; but three copies of the parser
 * drifted, and the drift was the hole. Each of the three met a shape the others
 * had not and grew its own answer to it, and two of those answers were weaker
 * than the strongest one. One parser, three configurations: a package declares
 * its seeds, its floor, the files that must compare, its exemptions and which
 * function decides, and nothing else.
 *
 * **What a package gets.**
 *
 * - `gatedFiles` — every file that imports a credential primitive, plus
 *   everything those files import for a value, transitively. A helper split out
 *   of a gated file is gated by the act of importing it.
 *   `expectedGated` is a floor under that: if a refactor stops a file being
 *   reached, the gate covers less than it did and someone has to look.
 * - `unexemptedComparisons` — comparisons of things that may be secret, by
 *   `===`, `!==`, `==`, `!=` or `.equals(`, minus the ones a package has
 *   exempted by exact text in one named function.
 * - `staleExemptions` — an exemption that no longer matches anything, so the
 *   list cannot rot.
 * - `whyDeciderDoesNotDecide` — whether the result of the deciding call
 *   actually decides the answer, in each function that calls it, plus a floor:
 *   `expectedComparers` names the files that must compare, whatever their text
 *   says today. Without that floor, deleting a call *and its import* left the
 *   file out of the set and another file's call covered for it.
 *
 * **Holes that remain**, stated rather than implied:
 *
 * - It reads text, not semantics. A comparison that avoids `==`, `!=` and
 *   `.equals(` — bitwise work on two buffers, a hand-rolled loop, a comparison
 *   method this file has never heard of — is invisible to it. So is a `switch`
 *   on a digest with the stored value as a `case`, which compares exactly as
 *   early-exitingly and contains no operator to find.
 * - It does not prove the comparison it finds runs in constant time, only that
 *   the source calls the function this codebase uses for that.
 * - It follows relative imports **for their values**. A comparison in another
 *   workspace package, or reached through a dynamic `import()`, is outside its
 *   reach — which is why each package configures it rather than trusting
 *   another package's run. A type-only import names nothing that exists at
 *   runtime, so it is not followed. A side-effect import — `import './x.js'`,
 *   with no bindings and so no `from` — is not followed either, and nothing in
 *   this tree imports that way; a file that starts to is the moment to write it.
 * - It traces the deciding call's result through `return`, an assignment read
 *   in a later `return` or condition, and continuation lines. A result routed
 *   through a data structure, or through a second function, is not followed.
 * - It says nothing about randomness. A package that mints a credential needs
 *   its own check for that; `Math.random` is legitimate in a package that picks
 *   a weighted target with it.
 * - **Every package but this one runs the built copy of this file.** They import
 *   it by package name, which resolves to `dist`, so weakening this source
 *   without rebuilding leaves their gates green on the previous version. The
 *   full gate builds before it tests, so that is a hazard while editing rather
 *   than one that reaches a commit — but it is why the tests beside this file
 *   exercise the parser directly instead of only through a package's own source.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** A comparison of something that is not secret, allowed in one place only. */
export interface Exemption {
  /** As `sourceFiles` names it, relative to `dir`. */
  file: string
  /** The declared function it sits in, or `(module)`. */
  fn: string
  /** The whole expression, whitespace collapsed. */
  expression: string
  /** Why it is not a secret comparison. Read by people, not by code. */
  because: string
}

/**
 * Which text a package's comparison check reads. `whole-file` covers an arrow
 * function, a class method and a module-level expression, none of which a "find
 * the function declarations" pass sees. `functions` reads one named function per
 * file, for a package where the rest of the file legitimately compares
 * parameters, lengths and prefixes that are not secret.
 */
export type ComparisonScope =
  | { kind: 'whole-file' }
  | { kind: 'functions'; functions: Record<string, string> }

export interface HygieneConfig {
  /** The package's source directory. */
  dir: string
  /** Importing one of these makes a file a starting point. */
  primitives: string[]
  /** Files the walk must reach. A floor, never trimmed to pass. */
  expectedGated: string[]
  /** Files that must compare with `decider`, whatever their text says today. */
  expectedComparers: string[]
  /** The call whose result must decide the answer. */
  decider: string
  /**
   * True when `decider` throws on a length mismatch, so the two lengths must be
   * compared before it is called: `timingSafeEqual` does, `digestsMatch` does
   * its own length check and does not.
   */
  lengthCheckedFirst: boolean
  scope: ComparisonScope
  allowed: Exemption[]
  /**
   * Functions exempt from the length requirement, because they make the two
   * lengths equal instead of comparing them — deriving a key at the stored
   * key's own length, say, where a mismatch cannot arise. Each is checked for
   * staleness like any other exemption.
   */
  lengthExempt?: { file: string; fn: string; because: string }[]
  /** Files never scanned: a test-only helper, say. */
  skip?: string[]
}

/** The name an expression is attributed to when it sits outside any function. */
export const MODULE_LEVEL = '(module)'

/**
 * Removes line and block comments, so a check further down never counts dead,
 * commented-out text as evidence that live code does something.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every source file in a package and its subdirectories, as relative paths. */
export function sourceFiles(c: HygieneConfig, dir = c.dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(c, full))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const name = relative(c.dir, full)
    if (c.skip?.includes(name)) continue
    out.push(name)
  }
  return out.sort()
}

export const readSource = (c: HygieneConfig, file: string): string =>
  stripComments(readFileSync(join(c.dir, file), 'utf8'))

/**
 * The names a file imports from another package or from Node, `type` specifiers
 * dropped. Both sources matter: some primitives come from `node:crypto` and some
 * from the core package.
 */
export function importedNames(source: string): string[] {
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
 * The package-relative files a file imports **for a value**, as `sourceFiles`
 * names them.
 *
 * A statement starts at the beginning of a line or after a `;`, so a re-export
 * — which carries no `import` keyword of its own — is classified by where its
 * own statement starts rather than by whatever precedes it. Scanning backwards
 * for the nearest `import` took the classification of the statement above, so
 * the same line was followed or skipped depending on what sat over it. The
 * clause may not contain a quote, which is what stops a match running past its
 * own module specifier into the next statement's.
 */
export function localImports(dir: string, file: string, source: string): string[] {
  const from = dirname(join(dir, file))
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
    out.push(relative(dir, resolve(from, (match[2] as string).replace(/\.js$/, '.ts'))))
  }
  return out
}

/** Every file that imports a credential primitive, plus what those reach. */
export function gatedFiles(c: HygieneConfig): string[] {
  const all = new Set(sourceFiles(c))
  const primitives = new Set(c.primitives)
  const queue = [...all].filter((f) =>
    importedNames(readSource(c, f)).some((n) => primitives.has(n)),
  )
  const gated = new Set(queue)
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const next of localImports(c.dir, file, readSource(c, file))) {
      if (!all.has(next) || gated.has(next)) continue
      gated.add(next)
      queue.push(next)
    }
  }
  return [...gated].sort()
}

export interface Comparison {
  expression: string
  why: string
  /** Where it sits in the text scanned, so it can be attributed to a function. */
  at: number
}

/** Where an operand stops, scanning outward from the operator. */
const BOUNDARY = /[(){}[\];,\n?:]/
/** `?` ends a ternary's operand, but `?.` is inside one whole value. */
const optionalChain = (text: string, i: number): boolean => text[i] === '?' && text[i + 1] === '.'

/**
 * The operand to the right of an operator, as raw text. Its extent has to be
 * found by scanning: a call has its own balanced parentheses, so it does not end
 * at the first `)` — it ends at the `)` that returns depth to zero, or at `&&`,
 * `||`, `;`, `,` or a newline at depth zero, whichever comes first.
 */
export function rhsText(text: string, opEnd: number): string {
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
export function lhsText(text: string, opStart: number): string {
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

/**
 * Equality is not banned outright: this code legitimately compares a value to
 * `null` or `undefined`, a length to a number, a flag to `false`, or a tag to a
 * string literal, long before it reaches any secret. Neither operand there is
 * the thing being verified, and a literal written in the source cannot be a
 * stored digest. `typeof x` is a whole value too — one of a handful of fixed
 * words, never secret material.
 *
 * Loose `==` and `!=` are matched as well as the strict pair. They compare just
 * as early-exitingly, and a "tidy up" that drops a character must not walk out
 * of the gate — one of the three copies this replaces matched only the strict
 * pair, so `return ok || a == b` between two secrets passed it while `===`
 * failed.
 *
 * Banned regardless of what is on the other side: `.equals(`, which has no
 * legitimate use in this tree; an operand that is a call or template result,
 * which routes the comparison around whatever it looks like as plain text
 * (`hashToken(x) === row.secret_hash` compares strings built from the secret
 * material); and an operand that is an expression rather than one whole value,
 * since `presented === '' + stored` is a concatenation whose first piece is an
 * innocent-looking literal.
 */
export function findDisallowedComparisons(body: string): Comparison[] {
  const violations: Comparison[] = []
  for (const match of body.matchAll(/[\w$]+\.equals\(/g)) {
    violations.push({ expression: match[0], why: 'compares with .equals(', at: match.index })
  }
  const opRe = /!==|===|!=|==/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((match = opRe.exec(body))) {
    const op = match[0]
    // A keyword in front of the operand is not part of it: `return a === 1`
    // compares `a`, not `return a`. `typeof` stays, being the value compared.
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

export interface FunctionBody {
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
export function functionBodies(source: string): FunctionBody[] {
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

/**
 * The innermost declared function containing an offset, or `(module)`.
 * Innermost by extent, so a helper declared inside another function is named
 * rather than its parent: an exemption granted to the outer one must not cover
 * it.
 */
export function enclosingFunction(functions: FunctionBody[], at: number): string {
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

/** The text a package's comparison check reads for one file, and its offset base. */
function scanned(c: HygieneConfig, file: string): { text: string; offset: number } {
  const source = readSource(c, file)
  if (c.scope.kind === 'whole-file') return { text: source, offset: 0 }
  const name = c.scope.functions[file]
  if (name === undefined) return { text: '', offset: 0 }
  const fn = functionBodies(source).find((f) => f.name === name)
  if (!fn) throw new Error(`${file}: ${name} not found, so nothing was scanned`)
  return { text: fn.body, offset: fn.start }
}

/** Every disallowed comparison in a file, each named by the function it sits in. */
export function comparisonsIn(
  c: HygieneConfig,
  file: string,
): { fn: string; expression: string; why: string }[] {
  const functions = functionBodies(readSource(c, file))
  const { text, offset } = scanned(c, file)
  return findDisallowedComparisons(text).map((v) => ({
    fn: enclosingFunction(functions, v.at + offset),
    expression: v.expression,
    why: v.why,
  }))
}

/**
 * The comparisons in a file that no exemption covers.
 *
 * An exemption applies in the one file and function it was granted for, and
 * nowhere else: the same text elsewhere is an unexempted comparison. And only
 * while that name means one function — a second declaration of it would
 * otherwise inherit the exemption, so an exemption over a duplicated name
 * applies nowhere and the file fails until the names are distinct again.
 */
export function unexemptedComparisons(
  c: HygieneConfig,
  file: string,
): { fn: string; expression: string; why: string }[] {
  const declared = functionBodies(readSource(c, file)).map((fn) => fn.name)
  const exempt = new Set(
    c.allowed
      .filter((a) => a.file === file && declared.filter((n) => n === a.fn).length === 1)
      .map((a) => `${a.fn}: ${a.expression}`),
  )
  return comparisonsIn(c, file).filter((v) => !exempt.has(`${v.fn}: ${v.expression}`))
}

/**
 * Every exemption that no longer matches a comparison in the file it names, as
 * a line naming it. A file that has left the gated set counts as stale too: an
 * exemption over unscanned source exempts nothing and hides that it stopped
 * applying.
 */
export function staleExemptions(c: HygieneConfig): string[] {
  const gated = new Set(gatedFiles(c))
  return c.allowed
    .filter((a) => {
      const found = gated.has(a.file)
        ? comparisonsIn(c, a.file).map((v) => `${v.fn}: ${v.expression}`)
        : []
      return !found.includes(`${a.fn}: ${a.expression}`)
    })
    .map((a) => `${a.file}#${a.fn} ${a.expression} (${a.because})`)
}

/** The lines between a `return`/assignment/condition anchor and the call. */
function chainedToCall(text: string, anchorEnd: number, call: number): boolean {
  const linesBefore = text
    .slice(anchorEnd, call)
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.trim().length > 0)
  return linesBefore.every((line) => /(?:&&|\|\||=)\s*$/.test(line.trimEnd()))
}

/** A statement comparing two lengths to each other that also returns or throws. */
const GUARDING_LENGTH_CHECK =
  /\.length\s*(?:!==|===|!=|==)\s*[\w$]+(?:\??\.[\w$]+)*\.length[^\n]*\b(?:return|throw)\b/
const TWO_LENGTHS = /\.length\s*(?:!==|===|!=|==)\s*[\w$]+(?:\??\.[\w$]+)*\.length/

/**
 * Why a function body's use of the deciding call does not decide anything, or
 * the empty string when it does.
 *
 * Three things have to hold, and each was a way past one of the copies this
 * replaces.
 *
 * The call must be **returned, assigned or used as a condition**. One written as
 * its own statement with the result thrown away decides nothing, and the line
 * before it ends in whatever the previous statement ended in, so the
 * continuation chain breaks at the first line boundary even though a `return`
 * appears earlier in the body.
 *
 * When it is assigned, the name must go on to **decide the answer**: appear in a
 * later `return`, or in an `if`/`while` condition. A result read only by a log
 * line, or by nothing at all, decides nothing — and reading it *somewhere* was
 * all the earlier rule asked for.
 *
 * And where the call throws on a length mismatch, **the two lengths must be
 * compared to each other first**, either on the way from the anchor to the call
 * or on a statement that returns or throws. A bound on one length — which the
 * callers here also have — does not stop the two from differing, and counting it
 * let the real check be deleted with the gate still green. A dead
 * `const sameLength = a.length === b.length` that nothing reads satisfies
 * neither form.
 */
export function whyDeciderDoesNotDecide(
  c: HygieneConfig,
  body: string,
  o: { lengthExempt?: boolean } = {},
): string {
  const call = `${c.decider}(`
  const callIndex = body.indexOf(call)
  if (callIndex === -1) return `${c.decider} is not called here`
  const needsLength = c.lengthCheckedFirst && o.lengthExempt !== true
  const guarded = GUARDING_LENGTH_CHECK.test(body.slice(0, callIndex))
  const anchorRe =
    /\breturn\b|\bif\s*\(|\bwhile\s*\(|(?:const|let|var)\s+([\w$]+)\s*=(?!=)|([\w$]+)\s*=(?!=)/g
  let anchor: RegExpExecArray | null
  let sawUnread = false
  let sawUnguarded = false
  // biome-ignore lint/suspicious/noAssignInExpressions: exec's own idiom for a global regex
  while ((anchor = anchorRe.exec(body))) {
    const anchorEnd = anchor.index + anchor[0].length
    const at = body.indexOf(call, anchorEnd)
    if (at === -1) continue
    if (!chainedToCall(body, anchorEnd, at)) continue
    if (needsLength && !guarded && !TWO_LENGTHS.test(body.slice(anchor.index, at))) {
      sawUnguarded = true
      continue
    }
    const assignedTo = anchor[1] ?? anchor[2]
    if (assignedTo === undefined) return ''
    const rest = body.slice(at)
    const decides =
      new RegExp(`\\breturn\\b[^\\n;]*\\b${assignedTo}\\b`).test(rest) ||
      new RegExp(`\\b(?:if|while)\\s*\\([^)]*\\b${assignedTo}\\b`).test(rest)
    if (decides) return ''
    sawUnread = true
  }
  if (sawUnguarded) return `the two lengths are not compared before ${c.decider} is called`
  return sawUnread
    ? `${c.decider}'s result is assigned to a name that decides nothing`
    : `${c.decider} is neither returned nor assigned`
}

const lengthExempt = (c: HygieneConfig, file: string, fn: string): boolean =>
  (c.lengthExempt ?? []).some((e) => e.file === file && e.fn === fn)

/** Every function in a file that calls the decider without letting it decide. */
export function decisionProblems(c: HygieneConfig, file: string): string[] {
  const call = `${c.decider}(`
  const out: string[] = []
  for (const fn of functionBodies(readSource(c, file))) {
    if (!fn.body.includes(call)) continue
    const why = whyDeciderDoesNotDecide(c, fn.body, {
      lengthExempt: lengthExempt(c, file, fn.name),
    })
    if (why) out.push(`${file}#${fn.name}: ${why}`)
  }
  return out
}

/**
 * Every length exemption that no longer names a function calling the decider, so
 * one left behind by a rename or a deletion fails rather than sitting there.
 */
export function staleLengthExemptions(c: HygieneConfig): string[] {
  const call = `${c.decider}(`
  return (c.lengthExempt ?? [])
    .filter((e) => {
      const gated = gatedFiles(c)
      if (!gated.includes(e.file)) return true
      const fn = functionBodies(readSource(c, e.file)).find((f) => f.name === e.fn)
      return fn === undefined || !fn.body.includes(call)
    })
    .map((e) => `${e.file}#${e.fn} (${e.because})`)
}

/**
 * The files that must compare and do not, as a line each. Declared rather than
 * inferred from the imports: a file whose call *and* import were both deleted
 * simply left an inferred set, and another file's call covered for it — which
 * is what a real edit looks like, since an unused import is a lint error.
 */
export function missingComparers(c: HygieneConfig): string[] {
  const call = `${c.decider}(`
  return c.expectedComparers
    .filter((file) => {
      const functions = functionBodies(readSource(c, file)).filter((fn) => fn.body.includes(call))
      return (
        functions.length === 0 ||
        functions.some(
          (fn) =>
            whyDeciderDoesNotDecide(c, fn.body, {
              lengthExempt: lengthExempt(c, file, fn.name),
            }) !== '',
        )
      )
    })
    .map((file) => `${file} no longer decides a match with ${c.decider}`)
}
