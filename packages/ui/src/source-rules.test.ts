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

// The CSS Color Module's named colours. `transparent`, `currentColor`,
// `inherit` and `none` are deliberately absent: they carry no colour of their
// own and are never flagged.
const NAMED_COLOURS = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]

/**
 * A named colour used as an actual value, not as part of an identifier: a
 * CSS declaration's value in a stylesheet, or an SVG `fill`/`stroke`
 * attribute or a style object's `color`/`backgroundColor` in JSX.
 */
function findNamedColours(set: string[]): string[] {
  const named = new RegExp(`\\b(?:${NAMED_COLOURS.join('|')})\\b`, 'i')
  // A CSS declaration's value: from the colon to the next `;`, `{` or `}`, so
  // a colour later in a shorthand value (`border: 1px solid white;`) is
  // still caught, and the match never crosses into the next rule.
  const cssDeclaration = /:[^;{}]*/g
  // An SVG paint attribute, or a style object's colour property, each with a
  // quoted value on the same line.
  const jsxColourValue = /\b(?:fill|stroke|color|backgroundColor)\s*[:=]\s*\{?\s*['"][^'"]*['"]/g
  const out: string[] = []
  for (const p of set) {
    const pattern = p.endsWith('.css') ? cssDeclaration : jsxColourValue
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null = pattern.exec(line)
        while (match) {
          if (named.test(match[0])) {
            out.push(`${relative(SRC, p)}:${i + 1}: ${line.trim()}`)
            break
          }
          match = pattern.exec(line)
        }
      })
  }
  return out
}

describe('the source', () => {
  it('states no colour of its own: every colour is a role from the brand tokens', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab)\(/
    const palette =
      /\b(text|bg|border|ring|fill|stroke|outline|from|to|via|decoration|shadow|accent|caret)-(white|black|(slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/
    const dark = /\bdark:/
    const found = [
      ...find(shipped, literal),
      ...find(shipped, palette),
      ...find(shipped, dark),
      ...findNamedColours(shipped),
    ]
    expect(
      found,
      'A colour in source bypasses the measured brand roles: a destructive button with text-white passes in light and fails in dark. Use a semantic class (bg-primary, text-destructive…) or var(--color-…).',
    ).toEqual([])
  })

  it('draws every focus ring at full opacity, never with a translucent modifier', () => {
    // A translucent ring composites the accent or danger colour under the
    // surface behind it, which can fall well under 3:1 — the one state a
    // keyboard user relies on to find the control at all. `aria-invalid`'s
    // ring is a decoration beside an already-opaque border and is not this
    // rule's concern; only `focus-visible`'s own ring is.
    const found = find(shipped, /focus-visible:ring-[a-z-]+\/\d+/)
    expect(
      found,
      'A translucent focus ring can composite under 3:1. Use the ring colour at full opacity (ring-ring, …).',
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
    // A statement can be a side-effect import (`import '@clickmonk/core'`,
    // nothing on its line to grep for `from`) or span several lines, so this
    // is matched against each file's whole text. `[^;]` already spans
    // newlines on its own; `m` is only for the `^` anchors, one per line.
    // `import type`/`export type` are excluded by the lookahead right after
    // the keyword, not by a same-line text check, so a multi-line
    // `import type {\n  Link,\n} from '@clickmonk/core'` still passes.
    const pattern =
      /^\s*(?:import|export)\b(?!\s+type\b)[^;]*?['"]@clickmonk\/(?:core|ipdata|db|admin|worker)/m
    const found = shipped
      .filter((p) => pattern.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p))
    expect(
      found,
      'The service packages pull in Node modules, and a bundle that evaluates one at load is a blank page. Restate the value in api/vocabulary.ts; its test compares the two.',
    ).toEqual([])
  })

  it('never dims a screen with an opacity utility while content reloads', () => {
    // A screen marks the region that is reloading with aria-busy and keeps it
    // at full contrast; the visible cue belongs on the Refresh button
    // ("Refreshing…"), not on the content behind it. opacity-50 dropped
    // muted text to about 2.2:1 and body text to about 3.5:1 in the light
    // theme for as long as the reload took, and nothing under screens/ has a
    // legitimate reason to fade with opacity, so any weight is refused
    // rather than just the one value that was found in use.
    const screens = shipped.filter((p) => /[\\/]screens[\\/]/.test(p))
    const found = find(screens, /\bopacity-\d+\b/)
    expect(
      found,
      'Dimming a busy region drops it under 3:1. Mark it aria-busy and leave its opacity alone.',
    ).toEqual([])
  })

  it('never dims a busy region by swapping in text-muted-foreground either', () => {
    // The same dimming can be reached without opacity: a conditional class
    // that reads for muted colour only while a loading/stale/busy flag is
    // set composites text under the same 3:1 risk the opacity check refuses.
    // Matched against each className={…} attribute's whole value rather than
    // one line at a time, so a ternary Prettier has wrapped across several
    // lines is still caught. `[^{}]*(?:\{[^{}]*\}[^{}]*)*` is a one-level
    // brace matcher, not a parser — it is enough for a ternary or a
    // template literal inside the attribute, which is every shape this
    // codebase's conditional classNames take, but a second level of nested
    // braces would close the match early. This is still a narrower net than
    // the opacity check: a muted-colour class and a loading-shaped
    // identifier must both appear in the same attribute, so a legitimate,
    // unconditional text-muted-foreground (a caption, a hint, a footer)
    // never matches.
    const screens = shipped.filter((p) => /[\\/]screens[\\/]/.test(p))
    const classNameValue = /className=\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
    const found = screens.flatMap((p) => {
      const text = readFileSync(p, 'utf8')
      const out: string[] = []
      for (const m of text.matchAll(classNameValue)) {
        const value = m[1] ?? ''
        const muted = /\btext-muted-foreground\b/.test(value)
        const loadingShaped = /\b(stale|loading|busy)\b/i.test(value)
        const conditional = /\?/.test(value)
        if (muted && loadingShaped && conditional) {
          const line = text.slice(0, m.index).split('\n').length
          out.push(`${relative(SRC, p)}:${line}: ${value.trim().replace(/\s+/g, ' ')}`)
        }
      }
      return out
    })
    expect(
      found,
      'A muted colour swapped in while a load is stale/loading/busy dims it the same way opacity-50 did. Keep the busy region at full contrast; mark it aria-busy instead.',
    ).toEqual([])
  })

  it('uses no Radix primitive that injects a style element', () => {
    // A named import list can span several lines (one name per line), and
    // `[^}]` already spans newlines on its own — no flag needed for that.
    // A namespace import (`import * as Radix from 'radix-ui'`) or a
    // re-export (`export { Dialog } from 'radix-ui'`) reach the same
    // primitives without ever naming one next to `from`, so both are
    // matched too: a namespace import pulls in every primitive, named or
    // not, and is refused outright rather than inspected for which
    // properties are read off it.
    const primitives =
      'Dialog|AlertDialog|Select|DropdownMenu|Popover|Tooltip|HoverCard|ContextMenu|Menubar|NavigationMenu|Sheet'
    const named = new RegExp(
      `(?:import|export)\\s*\\{[^}]*\\b(?:${primitives})\\b[^}]*\\}\\s*from\\s*['"]radix-ui['"]`,
    )
    const namespace = /(?:import|export)\s*\*\s*as\s+\w+\s*from\s*['"]radix-ui['"]/
    const found = shipped
      .filter((p) => {
        const text = readFileSync(p, 'utf8')
        return named.test(text) || namespace.test(text)
      })
      .map((p) => relative(SRC, p))
    expect(
      found,
      'These inject <style> elements at runtime, which the content security policy refuses. Use components/ui/modal.tsx (the native <dialog>) or a native <select>.',
    ).toEqual([])
  })
})
