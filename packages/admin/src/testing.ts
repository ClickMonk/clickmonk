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

/** An app on the admin host, silent, with the test's own clock. */
export function testApp(
  pg: Pool,
  clock: TestClock,
  extra: Partial<AdminDeps> = {},
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
    { trustProxy: false },
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

/** Creates the account and signs in; returns the cookie header a browser would hold. */
export async function signedIn(
  app: FastifyInstance,
  pg: Pool,
  password = ADMIN_PASSWORD,
): Promise<string> {
  await createAccount(pg, { email: ADMIN_EMAIL, password })
  return signInAs(app, password)
}
