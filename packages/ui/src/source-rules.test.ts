import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'fonts' ? [] : files(p)
    return /\.(tsx?|css)$/.test(name) ? [p] : []
  })
}

const all = files(SRC).filter((p) => !p.endsWith('source-rules.test.ts'))
const shipped = all.filter((p) => !/\.test\.tsx?$/.test(p) && !p.endsWith('test-setup.ts'))

/** Every match of a pattern in a set of files, as `path:line: text`. */
function find(set: string[], pattern: RegExp): string[] {
  const out: string[] = []
  for (const p of set) {
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) out.push(`${relative(SRC, p)}:${i + 1}: ${line.trim()}`)
      })
  }
  return out
}

describe('the source', () => {
  it('states no colour of its own: every colour is a role from the brand tokens', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab)\(/
    const palette =
      /\b(text|bg|border|ring|fill|stroke|outline|from|to|via|decoration|shadow|accent|caret)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/
    const dark = /\bdark:/
    const found = [...find(shipped, literal), ...find(shipped, palette), ...find(shipped, dark)]
    expect(
      found,
      'A colour in source bypasses the measured brand roles: a destructive button with text-white passes in light and fails in dark. Use a semantic class (bg-primary, text-destructive…) or var(--color-…).',
    ).toEqual([])
  })

  it('puts no HTML from a string into the page, and evaluates no string', () => {
    const found = find(shipped, /dangerouslySetInnerHTML|\beval\(|new Function\(/)
    expect(
      found,
      'Text from a response is rendered as text. Nothing is parsed as HTML or run as code.',
    ).toEqual([])
  })

  it('imports nothing from the service’s packages at runtime', () => {
    const found = find(shipped, /from '@clickmonk\/(core|ipdata|db|admin|worker)/).filter(
      (l) => !/import type/.test(l),
    )
    expect(
      found,
      'The service packages pull in Node modules, and a bundle that evaluates one at load is a blank page. Restate the value in api/vocabulary.ts; its test compares the two.',
    ).toEqual([])
  })

  it('uses no Radix primitive that injects a style element', () => {
    // An import statement can span several lines (a named import list broken
    // one name per line), which a line-by-line match misses. Matched against
    // each file's whole text instead, with `s` so `.` crosses newlines.
    const primitives =
      'Dialog|AlertDialog|Select|DropdownMenu|Popover|Tooltip|HoverCard|ContextMenu|Menubar|NavigationMenu|Sheet'
    const pattern = new RegExp(
      `import\\s*\\{[^}]*\\b(${primitives})\\b[^}]*\\}\\s*from\\s*'radix-ui'`,
      's',
    )
    const found = shipped
      .filter((p) => pattern.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p))
    expect(
      found,
      'These inject <style> elements at runtime, which the content security policy refuses. Use components/ui/modal.tsx (the native <dialog>) or a native <select>.',
    ).toEqual([])
  })
})
