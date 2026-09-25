import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_HOST,
  NETWORK,
  ROOT,
  TMP,
  WAIT_TIMEOUT,
  cli,
  cliWithInput,
  compose,
  curl,
  playwrightImage,
  publishZone,
  until,
  writeAcmeRoot,
} from './stack.js'

/**
 * The web interface in a real browser, on the shipped stack, over HTTPS with a
 * certificate from the stack's own authority. The `Secure` cookie, the
 * `Origin` check, the content security policy and the static serving are the
 * real ones, which no unit test of the interface or of the service can show.
 *
 * The browser runs in Playwright's own image on the stack's network, so it
 * reaches the admin host and the link domain by the names Caddy answers on.
 * The steps themselves are in packages/ui/e2e/interface.spec.ts.
 */
const EMAIL = 'admin@example.com'
const PASSWORD = 'a decent admin password'
const LINK_HOST = 'ui.example.test'

/**
 * Everything the browser writes: its report, its traces on a failure, the
 * download, the screenshots and the violation log. Under the suite's own
 * scratch directory, created here by whoever runs the suite, so that nothing
 * the browser writes lands in the source tree or belongs to another user.
 */
const OUT = join(TMP, 'e2e')

let setUp = false
let failed = false

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  publishZone()
  compose('up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  cliWithInput(PASSWORD, 'admin', 'create', EMAIL)
  // No DNS proof for this host: the escape hatch exists for exactly this, and
  // the suite that tests verification is the one that publishes a token.
  cli('domain', 'add', LINK_HOST, '--verified')

  // The certificate for the admin host is obtained on the first HTTPS request,
  // so wait for the handshake before the browser asks for anything. `-k`
  // because only the handshake is being waited for here; the browser is the
  // client whose trust matters, and it is told about the authority itself.
  await until(
    'a certificate for the admin host',
    120_000,
    () => curl(['-k', '--max-time', '10', `https://${ADMIN_HOST}/api/me`]).exit === 0,
  )

  // A previous run's output, removed so a stale violation log or screenshot
  // is never read as this run's.
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'home'), { recursive: true })
  setUp = true
}, 900_000)

afterAll(() => {
  try {
    if (failed || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
  }
}, 300_000)

describe('the interface in a browser', () => {
  it(
    'drives every screen on the shipped stack with no policy violation',
    () => {
      const r = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          NETWORK,
          // No duplicate-address detection for the container's own addresses.
          // With it, the IPv6 link-local address stays tentative for about two
          // seconds after the container starts and then changes state, and
          // Chromium reads that change as the network changing under it: the
          // first page load fails with ERR_NETWORK_CHANGED. Measured on this
          // stack's network; `default` rather than `all`, because only the
          // default is copied onto the interface as it is created.
          '--sysctl',
          'net.ipv6.conf.default.accept_dad=0',
          // Whoever ran the suite, so the files the browser writes are theirs;
          // a user the image has never heard of has no home, hence `HOME`.
          '--user',
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          '-e',
          `HOME=${OUT}/home`,
          '-e',
          `CLICKMONK_E2E_URL=https://${ADMIN_HOST}`,
          '-e',
          `CLICKMONK_E2E_EMAIL=${EMAIL}`,
          '-e',
          `CLICKMONK_E2E_PASSWORD=${PASSWORD}`,
          '-e',
          `CLICKMONK_E2E_LINK_HOST=${LINK_HOST}`,
          '-e',
          `CLICKMONK_E2E_OUT=${OUT}`,
          '-e',
          `CLICKMONK_SHOTS=${process.env.CLICKMONK_SHOTS ?? ''}`,
          // At its own path: pnpm's node_modules is a tree of symlinks with
          // absolute targets, and mounted anywhere else the library does not
          // resolve.
          '-v',
          `${ROOT}:${ROOT}`,
          '-w',
          join(ROOT, 'packages', 'ui'),
          playwrightImage(),
          // The runner's own entry point: `.bin/playwright` is a shell shim,
          // and handed to `node` it is a syntax error.
          'node',
          'node_modules/@playwright/test/cli.js',
          'test',
          '-c',
          'playwright.config.ts',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15 * 60_000 },
      )
      // 125 is docker's own failure, not the browser's: a missing image or
      // network would otherwise read as a failing step.
      if (r.error || r.status === 125) {
        failed = true
        throw new Error(`could not run the browser: ${r.error?.message ?? ''} ${r.stderr}`)
      }
      if (r.status !== 0) failed = true
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    },
    16 * 60_000,
  )

  // Read here as well as failed on in the spec, so that a violation is
  // reported by the suite that owns the stack even if the browser's own
  // failure message is lost. Written by the spec when it finishes; a run that
  // never got that far leaves no file, and reading it then fails.
  it('the browser saw no content-security-policy violation on any page', () => {
    try {
      const log = JSON.parse(readFileSync(join(OUT, 'violations.json'), 'utf8')) as unknown
      expect(log).toEqual([])
    } catch (err) {
      // So that `afterAll` prints the stack's logs for this failure too.
      failed = true
      throw err
    }
  })
})
