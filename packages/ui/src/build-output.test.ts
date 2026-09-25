import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const DIST = join(import.meta.dirname, '..', 'dist')

let html = ''
let css = ''

beforeAll(() => {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error(
      'run `pnpm --filter @clickmonk/ui build` first: this test reads the built output',
    )
  html = readFileSync(join(DIST, 'index.html'), 'utf8')
  const assets = readdirSync(join(DIST, 'assets'))
  const js = assets.filter((f) => f.endsWith('.js'))
  expect(
    js,
    'one chunk: nothing is lazy-loaded, so an upgrade cannot leave a page asking for a chunk that is gone',
  ).toHaveLength(1)
  const cssFile = assets.find((f) => f.endsWith('.css'))
  if (!cssFile) throw new Error('no built CSS file in dist/assets')
  css = readFileSync(join(DIST, 'assets', cssFile), 'utf8')
})

describe('the built stylesheet', () => {
  // Tailwind's preflight resets `border` to `0 solid`, which leaves the
  // colour at its default, currentColor. Without a base rule pointing every
  // border at the brand's role, a bare `border` class (the card, the
  // outline button, the table's rules) draws in whatever text colour is
  // inherited, not a border.
  it('gives every element a border colour from the brand role, not currentColor', () => {
    expect(css).toContain('border-color:var(--color-border)')
  })

  // The CSP is `font-src 'self'`: a font the browser is told to fetch from
  // the page's own origin. A font inlined as a data: URI would still render,
  // silently bypassing that policy rather than being caught by it.
  it('references the shipped fonts by URL, never inlines one as data', () => {
    const woff2Refs = css.match(/url\([^)]*\.woff2[^)]*\)/g) ?? []
    expect(woff2Refs.length).toBeGreaterThan(0)
    expect(woff2Refs.every((ref) => !ref.includes('data:'))).toBe(true)
    expect(css).not.toMatch(/data:font\//)
  })
})

describe('the built page', () => {
  it('carries no inline script, no style element and no style attribute', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts.every((s) => /\bsrc=/.test(s))).toBe(true)
    expect(scripts).toHaveLength(2)
    expect(html).not.toMatch(/<style\b/)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('loads the theme before the bundle', () => {
    expect(html.indexOf('/theme.js')).toBeGreaterThan(-1)
    expect(html.indexOf('/theme.js')).toBeLessThan(html.indexOf('/assets/'))
  })

  it('applies a stored dark theme when the theme script runs', () => {
    localStorage.setItem('cm-theme', 'dark')
    new Function(readFileSync(join(DIST, 'theme.js'), 'utf8'))()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('leaves the attribute off when nothing is stored, or something unknown is', () => {
    // Nothing stored: test-setup's beforeEach already cleared localStorage.
    new Function(readFileSync(join(DIST, 'theme.js'), 'utf8'))()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    localStorage.setItem('cm-theme', 'purple')
    new Function(readFileSync(join(DIST, 'theme.js'), 'utf8'))()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  // A module pulled into the bundle with a top-level side effect — a service
  // package's crypto setup — throws the moment the bundle is evaluated, and the
  // page is blank. Tree-shaking cannot prove a top-level call harmless, and a
  // grep of the minified bundle cannot find it by name. So the real built
  // bundle is evaluated here, and must render something.
  it('evaluates without throwing, and renders', async () => {
    const modules = import.meta.glob('../dist/assets/*.js')
    const [load] = Object.values(modules)
    if (!load) throw new Error('no built bundle')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = globalThis.fetch
    globalThis.fetch = () => new Promise(() => {})
    try {
      await load()
      // React 19 schedules its first commit, so the tree is there a tick later.
      await new Promise((r) => setTimeout(r, 0))
      expect(document.getElementById('root')?.children.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = fetch
    }
  })
})
