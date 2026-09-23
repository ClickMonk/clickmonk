import { hashToken, newApiKey } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from './account.js'
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, SESSION_IDLE_MS } from './auth.js'
import {
  ADMIN_EMAIL,
  ADMIN_HOST,
  ADMIN_PASSWORD,
  clockFrom,
  read,
  signInAs,
  signedIn,
  testApp,
  write,
} from './testing.js'

const pg = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-23T10:00:00.000Z'))
let app: FastifyInstance

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

beforeEach(async () => {
  clock.set(new Date('2026-09-23T10:00:00.000Z'))
  await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  await pg.query('TRUNCATE domains CASCADE')
  app = testApp(pg, clock)
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('what the admin service answers at all', () => {
  it('answers 503 on every route while no admin host is configured', async () => {
    const unconfigured = testApp(pg, clock, { adminHost: null })
    try {
      const r = await unconfigured.inject({ method: 'GET', url: '/api/me', headers: read() })
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('not_configured')
    } finally {
      await unconfigured.close()
    }
  })

  // Caddy serves /health to the whole internet on the admin host name, because
  // it is the one route in front of the host guard — Compose probes it on
  // 127.0.0.1, which is never the admin host. So it says the process is up and
  // nothing else: not whether the install is configured, and above all not
  // whether an admin account exists, which is the window in which the account
  // can still be claimed by whoever reaches the CLI first.
  it('answers liveness only, and says nothing about the install', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const configured = await app.inject({ method: 'GET', url: '/health' })
    expect(configured.statusCode).toBe(200)
    expect(configured.json()).toEqual({ status: 'ok' })

    const unconfigured = testApp(pg, clock, { adminHost: null })
    try {
      const r = await unconfigured.inject({ method: 'GET', url: '/health' })
      expect(r.statusCode).toBe(200)
      // Byte for byte the same answer, with an account and without a host.
      expect(r.json()).toEqual({ status: 'ok' })
      expect(r.body).not.toContain('admin')
      expect(r.body).not.toContain('not_configured')
    } finally {
      await unconfigured.close()
    }
  })

  // Readiness is behind the guards, where a credential has already been shown.
  it('reports whether an account exists only to a credential', async () => {
    const cookie = await signedIn(app, pg)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe(ADMIN_EMAIL)
    // And an install with no account says so, to a credential, at the same
    // place. Every table that references the account is truncated with it:
    // Postgres refuses a partial truncate of a referenced table, and the
    // account's credentials are gone anyway the moment the account is.
    await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
    const anonymous = await app.inject({ method: 'GET', url: '/api/me', headers: read() })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json().error).toBe('unauthenticated')
  })

  // The admin surface must not be reachable from a link domain. Caddy routes
  // by host name, and this is the second gate: any container on the Compose
  // network can open a connection to this port and send whatever Host it likes.
  it('answers 404 for every host name but its own', async () => {
    const cookie = await signedIn(app, pg)
    // No empty-Host case here: `inject` substitutes `localhost:80` for one, so
    // it would assert nothing the `localhost` row does not already assert.
    // An absent Host over a real socket is the stack suite's to show.
    for (const host of [
      'go.example.test',
      'localhost',
      `${ADMIN_HOST}.example.com`,
      `sub.${ADMIN_HOST}`,
    ]) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { host, cookie },
      })
      expect(r.statusCode, host).toBe(404)
      expect(r.json().error, host).toBe('not_found')
    }
  })

  it('answers its own host name with a port, as a browser sends it', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { host: `${ADMIN_HOST}:443`, cookie },
    })
    expect(r.statusCode).toBe(200)
  })

  it('puts no-store and the refusal headers on every answer, error or not', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: read() })
    expect(r.statusCode).toBe(401)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['content-security-policy']).toContain("default-src 'none'")
    expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  // The refusal headers are set in the request hook, before anything knows
  // whether a route will match, so the answer a stranger is most likely to get
  // carries them too. Pinned separately because the not-found handler is a
  // different code path from every route above it.
  it('puts the same headers on a route that does not exist', async () => {
    const r = await app.inject({ method: 'GET', url: '/not-a-route', headers: read() })
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toBe('not_found')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['content-security-policy']).toContain("default-src 'none'")
    expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('never answers a CORS header, so no other origin can read it', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { ...read(cookie), origin: 'https://evil.example.com' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
    expect(r.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('the session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict and host-only', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const r = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: write(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    const cookie = String(r.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
    // The `__Host-` prefix, which is what stops a sibling host under the same
    // registrable domain from setting a `Domain=`-scoped cookie of this name
    // and having the planted value be the one the parser keeps. A browser
    // refuses a `__Host-` cookie that carries a `Domain` attribute, so the
    // name cannot be forged from anywhere but this host — and the prefix only
    // holds if the cookie is also `Secure` with `Path=/`, asserted above.
    expect(cookie.startsWith('__Host-')).toBe(true)
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true)
  })

  // A stolen dump of `sessions` is not a way in: the row holds a digest, and
  // the cookie holds the token.
  it('stores only a digest of the token', async () => {
    const cookie = await signedIn(app, pg)
    const token = cookie.slice(cookie.indexOf('=') + 1)
    const r = await pg.query<{ token_hash: string }>('SELECT token_hash FROM sessions')
    expect(r.rows[0]?.token_hash).toBe(hashToken(token))
    expect(r.rows[0]?.token_hash).not.toContain(token)
  })

  it('is refused once its row is gone, which is what signing out does', async () => {
    const cookie = await signedIn(app, pg)
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })).statusCode,
    ).toBe(200)
    const out = await app.inject({ method: 'DELETE', url: '/api/session', headers: write(cookie) })
    expect(out.statusCode).toBe(200)
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0')
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(after.statusCode).toBe(401)
  })

  it('is refused after the idle bound, and the row is gone with it', async () => {
    const cookie = await signedIn(app, pg)
    clock.advance(SESSION_IDLE_MS + 1000)
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(r.statusCode).toBe(401)
    const rows = await pg.query('SELECT 1 FROM sessions')
    expect(rows.rowCount).toBe(0)
  })

  // Used just inside the idle bound, over and over, so the idle bound never
  // fires and the only thing that can end this session is the absolute one.
  // The assertion is *when* it ended, not merely that it eventually did: a
  // refusal after enough time has passed would also come from the idle bound,
  // which is why this walks until the first refusal and pins where it landed.
  it('is refused after the absolute bound however busy it was', async () => {
    const cookie = await signedIn(app, pg)
    const step = SESSION_IDLE_MS - 1000
    // Twice the absolute bound, so a session that is never ended is a loop
    // that finishes with nothing recorded rather than one that runs forever.
    let refusedAfterMs: number | null = null
    for (let elapsed = step; elapsed <= SESSION_ABSOLUTE_MS * 2; elapsed += step) {
      clock.advance(step)
      const r = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
      if (r.statusCode !== 200) {
        refusedAfterMs = elapsed
        break
      }
    }
    expect(refusedAfterMs).not.toBeNull()
    // At the absolute bound, and within one step of it: not before, and not
    // some later moment the idle bound would have reached anyway.
    expect(refusedAfterMs as number).toBeGreaterThanOrEqual(SESSION_ABSOLUTE_MS)
    expect(refusedAfterMs as number).toBeLessThan(SESSION_ABSOLUTE_MS + step)
    // And the row is gone, as it is at the idle bound.
    expect((await pg.query('SELECT 1 FROM sessions')).rowCount).toBe(0)
  })

  it('refuses a token that was never issued, whatever shape it is', async () => {
    await signedIn(app, pg)
    for (const value of ['', 'x', 'a'.repeat(43), 'a'.repeat(4000)]) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: read(`${SESSION_COOKIE}=${value}`),
      })
      expect(r.statusCode, value.slice(0, 8)).toBe(401)
    }
  })
})

describe('the cross-site write guard', () => {
  it('refuses a write with no Origin', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/session',
      headers: { host: ADMIN_HOST, cookie },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('bad_origin')
    // And the session it tried to end is still there.
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })).statusCode,
    ).toBe(200)
  })

  // The most valuable write to aim this at is the one that changes the
  // credential: it is refused before the password is even read, and the proof
  // is that the old password still signs in afterwards.
  it.each([
    ['another site', 'https://evil.example.com'],
    ['the admin host over plain http', `http://${ADMIN_HOST}`],
    ['a host the admin host is a prefix of', `https://${ADMIN_HOST}.evil.example.com`],
    ['null, as a sandboxed frame sends', 'null'],
  ])('refuses a write whose Origin is %s', async (_label, origin) => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: { host: ADMIN_HOST, origin, cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'a new decent password' },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('bad_origin')
    // Nothing changed: the password it tried to replace still signs in.
    const after = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: write(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    expect(after.statusCode).toBe(200)
  })

  it('allows a read with no Origin, so a browser can load the API at all', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { host: ADMIN_HOST, cookie },
    })
    expect(r.statusCode).toBe(200)
  })
})

describe('an API key', () => {
  // A key references the account row and cascades with it, so the account has
  // to exist before any key does. Every test here needs one, so it is made
  // once, here, and none of them calls `signedIn` — that would create a second.
  beforeEach(async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  })

  async function keyFor(pg_: typeof pg, name = 'scripting'): Promise<string> {
    const key = newApiKey()
    await pg_.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
      key.id,
      name,
      hashToken(key.secret),
    ])
    return key.display
  }

  // A key authenticates a read with no Origin at all. That it can also *write*
  // without one is pinned where the first key-writable endpoint lives.
  //
  // `/api/me` is deliberately readable by a key: it is how a script checks
  // which credential it is using. The line a key may not cross is managing
  // credentials, not reading the account's own address.
  it('authenticates a read without an Origin header', async () => {
    const key = await keyFor(pg)
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().credential).toBe('key')
  })

  // What a key may read there stops short of the account's sign-in history.
  // `failedLogins` and `lockedUntil` say whether someone is guessing the
  // password right now and whether the account is locked — a running
  // commentary on the admin's sign-ins, which a string in a script has no
  // business reading. A session sees both, and that is where they are for.
  it('is not told the failure count or the lockout', async () => {
    const key = await keyFor(pg)
    const byKey = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
    })
    expect(byKey.statusCode).toBe(200)
    expect(byKey.json()).not.toHaveProperty('failedLogins')
    expect(byKey.json()).not.toHaveProperty('lockedUntil')

    const cookie = await signInAs(app)
    const bySession = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(bySession.json().failedLogins).toBe(0)
    expect(bySession.json().lockedUntil).toBeNull()
  })

  // A stolen key must not be able to widen itself: not into a session, not
  // into another key, and not into a new password.
  // `/api/keys` is not in this list: it carries its own two rows of this same
  // check beside the routes that answer it.
  it.each([
    ['GET', '/api/sessions'],
    ['POST', '/api/password'],
    ['POST', '/api/totp'],
    ['POST', '/api/totp/confirm'],
    ['DELETE', '/api/totp'],
    ['POST', '/api/totp/recovery-codes'],
    ['DELETE', '/api/session'],
  ])('cannot reach %s %s', async (method, url) => {
    const key = await keyFor(pg)
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
      payload: method === 'GET' ? undefined : {},
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('session_required')
  })

  it('is refused once revoked, once expired, and when the secret is wrong', async () => {
    const live = await keyFor(pg, 'live')
    const revoked = await keyFor(pg, 'revoked')
    // A third key, neither revoked nor expired, so the wrong-secret row below
    // is refused by the secret check and by nothing else. Built from the
    // expired key's id, the row would pass whether the secret was compared or
    // not — which is what made this assertion pin nothing.
    const good = await keyFor(pg, 'good')
    await pg.query('UPDATE api_keys SET revoked_at = now() WHERE name = $1', ['revoked'])
    await pg.query("UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE name = $1", [
      'live',
    ])
    const expired = live
    // That live key's own id, with 43 characters of the wrong secret.
    const wrongSecret = `${good.split('_').slice(0, 2).join('_')}_${'a'.repeat(43)}`
    // It really is live: presented whole, it authenticates.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { host: ADMIN_HOST, authorization: `Bearer ${good}` },
        })
      ).statusCode,
    ).toBe(200)
    for (const key of [revoked, expired, wrongSecret, 'cmk_not_a_key', 'garbage']) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
      })
      expect(r.statusCode, key.slice(0, 12)).toBe(401)
      expect(r.json().error, key.slice(0, 12)).toBe('unauthenticated')
    }
  })

  it('is never read from a cookie or the query string', async () => {
    const key = await keyFor(pg)
    const viaCookie = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: read(`${SESSION_COOKIE}=${key}`),
    })
    expect(viaCookie.statusCode).toBe(401)
    const viaQuery = await app.inject({
      method: 'GET',
      url: `/api/me?key=${encodeURIComponent(key)}`,
      headers: read(),
    })
    expect(viaQuery.statusCode).toBe(401)
  })

  it('refuses a request that presents a session and a key at once', async () => {
    const cookie = await signInAs(app)
    const key = await keyFor(pg)
    const r = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { ...read(cookie), authorization: `Bearer ${key}` },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('ambiguous_credential')
  })

  it('records that it was used, at most once a minute', async () => {
    const key = await keyFor(pg)
    const ask = () =>
      app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { host: ADMIN_HOST, authorization: `Bearer ${key}` },
      })
    await ask()
    const first = await pg.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_keys')
    expect(first.rows[0]?.last_used_at?.toISOString()).toBe(clock.now().toISOString())
    clock.advance(1000)
    await ask()
    const unchanged = await pg.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_keys')
    expect(unchanged.rows[0]?.last_used_at?.toISOString()).toBe(
      first.rows[0]?.last_used_at?.toISOString(),
    )
    clock.advance(60_000)
    await ask()
    const later = await pg.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_keys')
    expect(later.rows[0]?.last_used_at?.toISOString()).toBe(clock.now().toISOString())
  })
})

describe('what a body may say', () => {
  // Whatever scopes a write comes from the credential. There is one admin, so
  // the checkable form of that rule is: no body may carry a field naming an
  // account, an owner or a verified flag, and every schema is strict.
  const change = { currentPassword: ADMIN_PASSWORD, newPassword: 'a new decent password' }

  it.each([
    ['an account id', { ...change, accountId: 'someone-else' }],
    ['an admin id', { ...change, adminId: 1 }],
    ['an owner', { ...change, owner: 'somebody' }],
    ['a password hash', { ...change, passwordHash: 'anything at all' }],
  ])('refuses a body carrying %s', async (_label, payload) => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(cookie),
      payload,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    // Refused whole: the password is unchanged, so the field was not merely
    // ignored on the way through.
    const after = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: write(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    expect(after.statusCode).toBe(200)
  })

  it('answers a body that is not JSON with 400, not 500', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: { ...write(cookie), 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
  })
})
