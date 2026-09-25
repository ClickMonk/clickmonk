import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const DIST = join(import.meta.dirname, '..', 'dist')

let html = ''

beforeAll(() => {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error(
      'run `pnpm --filter @clickmonk/ui build` first: this test reads the built output',
    )
  html = readFileSync(join(DIST, 'index.html'), 'utf8')
  const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
  expect(
    js,
    'one chunk: nothing is lazy-loaded, so an upgrade cannot leave a page asking for a chunk that is gone',
  ).toHaveLength(1)
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
