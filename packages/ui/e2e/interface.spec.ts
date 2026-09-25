import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserContext, type Page, expect, test } from '@playwright/test'
import { STEP_MS, totp } from './totp'

/**
 * The whole interface in a real browser, against the shipped stack over real
 * TLS: the `Secure` cookie, the `Origin` check, the content security policy
 * and the static serving are all the real ones. Every step is its own test,
 * in order, on one page in one browser context, because a sign-in in one step
 * has to still be there in the next — Playwright otherwise gives each test a
 * fresh context.
 *
 * Any content-security-policy violation on any page fails the step that
 * caused it, and every one is written to `violations.json` for the stack
 * suite that runs this file to read back.
 */

const env = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set; this suite is run by test/stack/ui.test.ts`)
  return v
}

const EMAIL = env('CLICKMONK_E2E_EMAIL')
const PASSWORD = env('CLICKMONK_E2E_PASSWORD')
const LINK_HOST = env('CLICKMONK_E2E_LINK_HOST')
const OUT = env('CLICKMONK_E2E_OUT')
const SHOTS = process.env.CLICKMONK_SHOTS === '1'

const SLUG = 'e2e'
const TARGET = 'https://example.com/e2e'
const LINK = `${LINK_HOST}/${SLUG}`
const NEW_HOST = 'new.example.test'

/** The interface's policy, written out rather than imported from the service that sends it. */
const UI_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const API_POLICY = "default-src 'none'; frame-ancestors 'none'"

/**
 * The first line of a click export: the service's field names, quoted, in its
 * order. Written out here so a column the service drops or renames fails.
 */
const CSV_HEADER =
  '"clickId","at","host","path","domainId","linkId","outcome","step","status","destination","targetId","visitorId","returning","country","region","city","geoSource","device","os","browser","asn","class","signals","action","referrer","userAgent","network","capUnchecked"'

let context: BrowserContext
let page: Page

/**
 * Every violation any page reported, as `<directive> <blocked URI>`. Reported
 * through a binding rather than kept on the page's `window`, so that a
 * violation on a page the test has since navigated away from is not lost with
 * that page.
 */
const violations: string[] = []
/** Every console message that names the policy, which is how Chromium also reports a refusal. */
const policyConsole: string[] = []
let violationsSeen = 0
let consoleSeen = 0

/** The TOTP key read off the enrolment dialog. Held in this process only. */
let key = ''
/** The last thirty-second step a code was sent for; the service accepts each code once. */
let lastStep = -1
/** The link the form created, by the id its page's address carries. */
let linkId = ''

/**
 * A code for a step after the last one used. Waits for the step to change
 * rather than computing a future one, so it never sends a code the service
 * would only accept because of its tolerance for clock drift.
 */
async function freshCode(): Promise<string> {
  while (Math.floor(Date.now() / STEP_MS) <= lastStep) await page.waitForTimeout(500)
  const now = Date.now()
  lastStep = Math.floor(now / STEP_MS)
  return totp(key, now)
}

async function h1(name: string | RegExp): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

/** Clicks the application's own Refresh, in the header every signed-in screen shares. */
async function refresh(): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: 'Refresh' }).click()
}

/**
 * The password, then — two-factor being on — the code the service asks for
 * next. Signing in keeps the address the browser was on, so the screen that
 * follows is the one `landsOn` names.
 */
async function signInWithCode(landsOn: string): Promise<void> {
  await h1('Sign in')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const code = page.getByLabel('Code from your authenticator app')
  await expect(code).toBeVisible()
  // The password is cleared only on a refusal; the code step keeps it.
  await expect(page.getByLabel('Password')).toHaveValue(PASSWORD)
  await code.fill(await freshCode())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await h1(landsOn)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  await context.exposeBinding('__cmViolation', (_source, v: string) => {
    violations.push(v)
  })
  await context.addInitScript(() => {
    const w = window as unknown as {
      __cmViolation?: (v: string) => void
      __themeAtParse?: string | null
    }
    // Capture on the window: every violation's target is in this document or
    // is the document, so each passes through here on the way down.
    window.addEventListener(
      'securitypolicyviolation',
      (e) => {
        void w.__cmViolation?.(`${e.violatedDirective} ${e.blockedURI}`)
      },
      true,
    )
    // The theme as it stood when the parser finished — which is before any
    // module or deferred script runs: the document becomes `interactive`
    // first, and only then are those scripts executed. So whatever this
    // records was set by the classic script in <head>, never by the bundle.
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive')
        w.__themeAtParse = document.documentElement.getAttribute('data-theme')
    })
  })
  page = await context.newPage()
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) policyConsole.push(msg.text())
  })
})

test.afterEach(async () => {
  const newViolations = violations.slice(violationsSeen)
  const newConsole = policyConsole.slice(consoleSeen)
  violationsSeen = violations.length
  consoleSeen = policyConsole.length
  expect(
    [...newViolations, ...newConsole],
    'content-security-policy violations during this step',
  ).toEqual([])
})

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'violations.json'), JSON.stringify([...violations, ...policyConsole]))
  await context?.close()
})

test('a policy violation on the page is seen, by the listener and on the console', async () => {
  await page.goto('/')
  await h1('Sign in')
  // A style element is exactly what the policy refuses, and what a component
  // library that injects its own styles would add. Added from outside the
  // page, so this test does not depend on anything the interface ships.
  await page.evaluate(() => {
    const s = document.createElement('style')
    s.textContent = 'body { outline: 0 }'
    document.head.append(s)
  })
  await expect.poll(() => violations.join('\n')).toMatch(/^style-src-elem inline$/m)
  await expect.poll(() => policyConsole.length).toBeGreaterThan(0)
  // Seen, so the listener works in this browser: set aside, so that only a
  // violation the interface itself causes fails a step.
  violations.length = 0
  policyConsole.length = 0
})

test('the page and the API carry their own policies, and assets are served as files', async () => {
  const pageRes = await page.request.get('/')
  expect(pageRes.status()).toBe(200)
  expect(pageRes.headers()['content-security-policy']).toBe(UI_POLICY)
  expect(pageRes.headers()['cache-control']).toBe('no-store')

  const api = await page.request.get('/api/me')
  expect(api.status()).toBe(401)
  expect(api.headers()['content-security-policy']).toBe(API_POLICY)

  // The bundle the loaded page really asked for, not a name written here.
  const src = await page.locator('script[type="module"]').getAttribute('src')
  expect(src).toMatch(/^\/assets\/index-[\w-]+\.js$/)
  const asset = await page.request.get(src as string)
  expect(asset.status()).toBe(200)
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(asset.headers()['content-security-policy']).toBe(UI_POLICY)

  // A hashed asset from another build is a missing file, not the page.
  const missing = await page.request.get('/assets/missing-0000.js')
  expect(missing.status()).toBe(404)
  expect(missing.headers()['content-type']).toMatch(/^application\/json/)
  expect(await missing.json()).toEqual({ error: 'not_found', message: 'no such route' })

  // A client route is the page.
  const route = await page.request.get('/links/anything')
  expect(route.status()).toBe(200)
  expect(route.headers()['content-type']).toMatch(/^text\/html/)
  expect(route.headers()['content-security-policy']).toBe(UI_POLICY)
  expect(await route.text()).toContain('<div id="root"></div>')
})

test('signs in with the password, in the zone the browser is in', async () => {
  await page.goto('/')
  await h1('Sign in')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await h1('Overview')
  // Times are shown in the browser's zone, and this one is half an hour off
  // the hour with daylight saving.
  await expect(page.getByText('Times in Australia/Adelaide', { exact: true })).toBeVisible()
})

test('enrols an authenticator, and signing in then asks for its code', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Account' })
    .click()
  await h1('Account')
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set up an authenticator app' })
  await dialog.getByLabel('Your password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Continue' }).click()

  // The key, in groups of four beside the QR code. The otpauth address it is
  // made from is never put in the page as text.
  const grouped = dialog.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/)
  await expect(grouped).toBeVisible()
  key = ((await grouped.textContent()) ?? '').replace(/\s/g, '')
  expect(key).toMatch(/^[A-Z2-7]{16,}$/)
  expect(await page.content()).not.toContain('otpauth://')

  const now = Date.now()
  lastStep = Math.floor(now / STEP_MS)
  await dialog.getByLabel('Code from the app').fill(totp(key, now))
  await dialog.getByRole('button', { name: 'Turn on two-factor' }).click()

  const codes = page.getByRole('dialog', { name: 'Your recovery codes' })
  await expect(codes.getByRole('listitem')).toHaveCount(10)
  await codes.getByRole('button', { name: 'I have saved them' }).click()
  await expect(codes).toBeHidden()
  await expect(page.getByText('On. 10 recovery codes left.', { exact: true })).toBeVisible()

  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click()
  // Signed out on the account screen, signed back in on it.
  await signInWithCode('Account')
})

test('shows the verified link domain, and adds one with the record that would verify it', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Domains' })
    .click()
  await h1('Domains')
  const verified = page.getByRole('region', { name: LINK_HOST })
  await expect(verified.getByText('Verified', { exact: true })).toBeVisible()

  await page.getByLabel('Host name').fill(NEW_HOST)
  await page.getByRole('button', { name: 'Add domain' }).click()
  const added = page.getByRole('region', { name: NEW_HOST })
  await expect(added.getByText('Not verified: its links answer 404', { exact: true })).toBeVisible()
  await expect(added.getByText(`_clickmonk.${NEW_HOST}`, { exact: true })).toBeVisible()
  await expect(added.getByText(/^clickmonk-verify=[0-9a-f]{32}$/)).toBeVisible()
  await expect(page.getByLabel('Host name')).toHaveValue('')
})

test('creates a link through the form and lands on its page', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Links' }).click()
  await h1('Links')
  await page.getByRole('link', { name: 'New link' }).click()
  await h1('New link')
  await page.getByLabel('Domain').selectOption(LINK_HOST)
  await page.getByLabel('Slug').fill(SLUG)
  await page.getByLabel('Target 1 URL').fill(TARGET)
  await page.getByRole('button', { name: 'Create link' }).click()
  await h1(LINK)
  const m = /\/links\/([^/?#]+)$/.exec(new URL(page.url()).pathname)
  expect(m).not.toBeNull()
  linkId = decodeURIComponent(m?.[1] ?? '')
  expect(linkId).not.toBe('new')
})

test('the link redirects on its own domain', async () => {
  // The redirect serves from a snapshot that reloads a quarter of a second
  // after a link is written, and the form's own navigation takes less than
  // that. Waited out rather than polled: every request to the link domain is
  // a click, a 404 included, and the steps after this one count exactly one.
  await page.waitForTimeout(2_000)
  const r = await page.request.get(`http://${LINK}`, { maxRedirects: 0 })
  expect(r.status()).toBe(302)
  expect(r.headers().location).toBe(TARGET)
})

test('the click arrives in the log, with its address cut to a network', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Clicks' }).click()
  await h1('Clicks')
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: LINK, exact: true }) })
  await expect(async () => {
    await refresh()
    await expect(row).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  // The address column: a network, never a bare address. The slash is required.
  const address = row.getByRole('cell').nth(5)
  await expect(address).toHaveText(/^[0-9a-f.:]+\/(24|64)$/)
})

test('exports the click as a file of one header and one row', async () => {
  await page.getByRole('button', { name: 'Export as CSV' }).click()
  await expect(page.getByText('1 click will be in the file.', { exact: true })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download the CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^clicks-.+\.csv$/)
  const text = readFileSync(await download.path(), 'utf8')
  const lines = text.split('\r\n').filter((l) => l !== '')
  expect(lines[0]).toBe(CSV_HEADER)
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain(`"${LINK_HOST}","/${SLUG}"`)
})

test('the overview counts the click and names its link', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Overview' })
    .click()
  await h1('Overview')
  const main = page.getByRole('main')
  // The summary card whose term is "Clicks": its value, beside it.
  const clicks = main
    .locator('dt', { hasText: /^Clicks$/ })
    .locator('xpath=following-sibling::dd[1]')
  await expect(async () => {
    await refresh()
    await expect(clicks).toHaveText('1', { timeout: 3_000 })
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  const topLinks = main
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Top links', exact: true }) })
  await expect(topLinks.getByText(LINK, { exact: true })).toBeVisible()
})

test('saves a setting, and a reload reads it back', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings' })
    .click()
  await h1('Settings')
  const threshold = page.getByLabel('Abuser threshold')
  await expect(threshold).not.toHaveValue('')
  await expect(threshold).not.toHaveValue('61')
  await threshold.fill('61')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('output', { hasText: 'Saved.' })).toBeVisible()
  await page.reload()
  await h1('Settings')
  await expect(page.getByLabel('Abuser threshold')).toHaveValue('61')
})

test('a stored dark theme is applied before the bundle runs', async () => {
  await page.getByRole('banner').getByRole('button', { name: 'Switch to dark theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await h1('Settings')
  const atParse = await page.evaluate(
    () => (window as unknown as { __themeAtParse?: string | null }).__themeAtParse,
  )
  expect(atParse).toBe('dark')
})

test("revoking this browser's own session ends it, and says so once", async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Account' })
    .click()
  await h1('Account')
  const own = page.getByRole('row').filter({ has: page.getByText('This browser', { exact: true }) })
  await expect(own).toHaveCount(1)
  await own.getByRole('button', { name: 'Sign out' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Sign this browser out?' })
  const reloaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sessions' && r.request().method() === 'GET',
    // Well above the moment the reload takes; a list that never reloads
    // fails here, saying so, rather than at the test's own timeout.
    { timeout: 15_000 },
  )
  await confirm.getByRole('button', { name: 'Sign this browser out' }).click()
  expect((await reloaded).status()).toBe(401)
  await h1('Sign in')
  await expect(page.getByText('Your session ended. Sign in again.', { exact: true })).toHaveCount(1)
})

const SCREENS: [name: string, path: () => string][] = [
  ['overview', () => '/overview'],
  ['links', () => '/links'],
  ['link', () => `/links/${encodeURIComponent(linkId)}`],
  ['link-new', () => '/links/new'],
  ['clicks', () => '/clicks'],
  ['domains', () => '/domains'],
  ['settings', () => '/settings'],
  ['account', () => '/account'],
]
const WIDTHS: [width: number, height: number][] = [
  [1280, 900],
  [390, 844],
]
const THEMES = ['light', 'dark'] as const

async function shoot(name: string): Promise<void> {
  const dir = join(OUT, 'shots')
  mkdirSync(dir, { recursive: true })
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height })
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: join(dir, `${name}-${width}-${theme}.png`), fullPage: true })
    }
  }
}

test('screenshots of every screen, in both themes, wide and narrow', async () => {
  test.skip(!SHOTS, 'written only when CLICKMONK_SHOTS=1')
  test.setTimeout(600_000)
  // No stored choice, so the emulated scheme decides the theme.
  await page.evaluate(() => localStorage.removeItem('cm-theme'))
  await page.goto('/')
  await h1('Sign in')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./)
  await shoot('sign-in')

  await page.setViewportSize({ width: 1280, height: 900 })
  await signInWithCode('Overview')
  for (const [name, path] of SCREENS) {
    await page.goto(path())
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await shoot(name)
  }
})
