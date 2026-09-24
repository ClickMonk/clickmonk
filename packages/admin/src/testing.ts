import type { Pool } from '@clickmonk/db'
import type { FastifyInstance } from 'fastify'
/**
 * What every admin suite needs: an app bound to a known host, a clock the
 * test moves, and a signed-in session.
 *
 * Excluded from the image build (`tsconfig.build.json`), like the database
 * helpers are: it is not named `*.test.ts`, so without that it would ship.
 */
import { createAccount } from './account.js'
import { type AdminDeps, buildAdminApp } from './app.js'
import { SESSION_COOKIE } from './auth.js'

export const ADMIN_HOST = 'admin.example.test'
export const ORIGIN = `https://${ADMIN_HOST}`
export const ADMIN_EMAIL = 'admin@example.com'
export const ADMIN_PASSWORD = 'a decent admin password'

export interface TestClock {
  now: () => Date
  /**
   * The monotonic reading the attempt counter is keyed on. It moves with
   * `advance()` and, unlike `now`, **`set()` does not move it backwards** —
   * which is the whole point: a test that walks the wall clock back must not
   * be able to clear a lockout, because neither can an attacker.
   */
  monotonic: () => number
  set(at: Date): void
  advance(ms: number): void
}

export function clockFrom(start: Date): TestClock {
  let at = start
  let tick = 0
  return {
    now: () => at,
    monotonic: () => tick,
    set(next) {
      at = next
    },
    advance(ms) {
      at = new Date(at.getTime() + ms)
      tick += ms
    },
  }
}

/**
 * The trusted-proxy list the Compose file gives the admin service, which is
 * also the redirect's. Named here so a test can build the app the way the
 * stack actually runs it rather than the way that happens to be convenient:
 * with these, every peer on the bridge network is trusted, and a test built on
 * `trustProxy: false` cannot see what that costs.
 */
export const SHIPPED_TRUSTED_PROXIES = ['uniquelocal', 'loopback']

/**
 * An app on the admin host, silent, with the test's own clock.
 *
 * `trustProxy: false` by default, because most suites are not about forwarded
 * headers and a false here keeps them reading what they were sent. A suite
 * that is about them passes `SHIPPED_TRUSTED_PROXIES`.
 *
 * A suite that reads a report passes `{ ch }` in `extra`; one that does not,
 * does not, and the report routes then answer 503 — which is a real answer
 * this service gives and has a test of its own. Nothing ClickHouse is
 * re-exported from here: each suite builds its own client with `testCh()`.
 */
export function testApp(
  pg: Pool,
  clock: TestClock,
  extra: Partial<AdminDeps> = {},
  opts: { trustProxy: string | string[] | boolean } = { trustProxy: false },
): FastifyInstance {
  return buildAdminApp(
    {
      pg,
      adminHost: ADMIN_HOST,
      now: clock.now,
      monotonic: clock.monotonic,
      log: false,
      ...extra,
    },
    opts,
  )
}

/** Headers a browser on the admin host would send with a write. */
export const write = (cookie?: string): Record<string, string> => ({
  host: ADMIN_HOST,
  origin: ORIGIN,
  ...(cookie ? { cookie } : {}),
})

/** Headers a browser would send with a read. */
export const read = (cookie?: string): Record<string, string> => ({
  host: ADMIN_HOST,
  ...(cookie ? { cookie } : {}),
})

/**
 * The `Cookie` header value for a session token taken from a `Set-Cookie`.
 * Built from `SESSION_COOKIE` rather than from the name written out, so a
 * change to the name — the `__Host-` prefix, say — cannot leave this reading
 * one cookie and sending another.
 */
export function cookieFrom(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const value = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(first ?? '')?.[1] ?? ''
  return `${SESSION_COOKIE}=${value}`
}

/**
 * Signs in against an account that already exists, and returns the cookie
 * header a browser would hold.
 *
 * Separate from `signedIn` because credentials reference the account row: a
 * test that has to create the account *before* it inserts a key or a session
 * cannot then call something that creates the account again.
 */
export async function signInAs(app: FastifyInstance, password = ADMIN_PASSWORD): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: write(),
    payload: { email: ADMIN_EMAIL, password },
  })
  if (r.statusCode !== 200) throw new Error(`sign-in failed: ${r.statusCode} ${r.body}`)
  return cookieFrom(r.headers['set-cookie'])
}

/**
 * Creates the account and signs in; returns the cookie header a browser would
 * hold.
 *
 * `now` is not optional, and it is the clock the app under test was built
 * with. A fixture that stamped the account from real time while the app stamps
 * every later write from a frozen clock would write a row whose history reads
 * as out of order, which is the shape this suite exists to catch elsewhere.
 */
export async function signedIn(
  app: FastifyInstance,
  pg: Pool,
  now: Date,
  password = ADMIN_PASSWORD,
): Promise<string> {
  await createAccount(pg, { email: ADMIN_EMAIL, password, now })
  return signInAs(app, password)
}
