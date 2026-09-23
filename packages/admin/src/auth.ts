import { digestsMatch, hashToken, newOpaqueToken, parseApiKey } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import type { FastifyRequest } from 'fastify'
import { fail, parseCookies } from './http.js'

/**
 * Who a request is, and what that lets it do.
 *
 * Two credentials, deliberately unequal. A **session** is a browser that
 * signed in with the password and, when it is enrolled, a one-time code: it
 * can do everything, including changing the password and minting API keys. An
 * **API key** is a string in a script: it can read and write domains, links
 * and settings, and it can do nothing to the credentials themselves. A stolen
 * key is therefore a key that cannot lock the admin out, cannot mint a second
 * key, and cannot become a login.
 *
 * Neither is ever taken from a request field. There is one admin account, so
 * "the tenant comes from the credential" reads here as: no endpoint accepts an
 * account, owner or admin id in a body, a query or a path, and every body
 * schema is strict, so sending one is a 400.
 */
/**
 * The `__Host-` prefix is not decoration. Without it, a sibling host under the
 * same registrable domain — a link domain on a subdomain, a stray staging box,
 * anything that can get a certificate — can set a cookie of this name scoped
 * with `Domain=`, and the browser then sends two cookies of the same name. The
 * request carries both, the parser keeps one, and the planted value can be the
 * one that wins: session fixation that neither `SameSite=Strict` nor the
 * `Origin` check touches, because the request really is same-site and really
 * does come from the admin origin. A browser refuses to set a `__Host-` cookie
 * that carries a `Domain` attribute at all, which is the only mechanism that
 * closes it, so the prefix is what makes the name unforgeable from a sibling.
 * It also requires `Secure` and `Path=/`, which this cookie already has.
 */
export const SESSION_COOKIE = '__Host-cm_admin'
/** A session ends this long after it was created, whatever it has been doing. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000
/** And this long after its last request. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
/**
 * `last_seen_at` and an API key's `last_used_at` are written at most this
 * often, so a script making a thousand requests a second does not make a
 * thousand writes a second to the same row.
 */
export const TOUCH_INTERVAL_MS = 60 * 1000

export interface Credential {
  kind: 'session' | 'key'
  /** The session's id, or the API key's public id. Never the token itself. */
  id: string
}

export interface NewSession {
  id: string
  /** Sent to the browser once, in the cookie. Only its digest is stored. */
  token: string
  expiresAt: Date
}

/**
 * Mints a session. The token is 32 random bytes; the database holds its
 * SHA-256 digest, so a dump of `sessions` cannot be replayed as a sign-in.
 */
export async function createSession(
  pg: Pool,
  o: { now: Date; userAgent: string; ip: string },
): Promise<NewSession> {
  const token = newOpaqueToken()
  const expiresAt = new Date(o.now.getTime() + SESSION_ABSOLUTE_MS)
  const r = await pg.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES ($1, $2, $2, $3, $4, $5) RETURNING id`,
    [hashToken(token), o.now, expiresAt, o.userAgent.slice(0, 200), o.ip.slice(0, 45)],
  )
  return { id: r.rows[0]?.id as string, token, expiresAt }
}

/**
 * Removes every session that is past either of its two bounds. Run after a
 * sign-in.
 *
 * Both bounds, not just the absolute one: a session is dead the moment either
 * has passed, and a row that only the idle bound has killed still carries a
 * future `expires_at`. Deleting on the absolute bound alone left those rows to
 * be listed as live, with an expiry weeks away, until the cookie happened to be
 * presented again — which for an abandoned browser is never. The admin reading
 * that list is reading it to decide whether anything is signed in that should
 * not be, so a dead row shown as live is the one thing it must not do.
 */
export async function deleteExpiredSessions(pg: Pool, now: Date): Promise<number> {
  const r = await pg.query('DELETE FROM sessions WHERE expires_at <= $1 OR last_seen_at <= $2', [
    now,
    new Date(now.getTime() - SESSION_IDLE_MS),
  ])
  return r.rowCount ?? 0
}

/**
 * The cookie the browser holds.
 *
 * `HttpOnly` so script cannot read it, `Secure` so it is never sent in clear,
 * `SameSite=Strict` so it is not sent on a request another site started at
 * all — which is the first of the two defences against cross-site writes; the
 * `Origin` check below is the second, because `SameSite` is the browser's
 * promise and not this service's.
 *
 * `Path=/` and no `Domain`: host-only, so it is never sent to a link domain
 * or to any other name.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
}

export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

const BEARER = /^Bearer (\S{1,200})$/

/**
 * Resolves the credential a request presents, or null for none.
 *
 * A request presenting both a session cookie and a bearer key is refused
 * rather than resolved to either: it is a bug or an attempt to confuse the
 * privilege check, and choosing one silently is how the weaker check ends up
 * being the one that ran. A bearer key is never read from a cookie or a query
 * parameter — a key in a URL ends up in logs, in a referrer and in browser
 * history.
 */
export async function authenticate(
  pg: Pool,
  req: Pick<FastifyRequest, 'headers'>,
  now: Date,
): Promise<Credential | null> {
  const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  const bearer = BEARER.exec(String(req.headers.authorization ?? ''))?.[1]
  if (cookie && bearer)
    fail(400, 'ambiguous_credential', 'send a session cookie or a key, not both')
  if (bearer) return authenticateKey(pg, bearer, now)
  if (cookie) return authenticateSession(pg, cookie, now)
  return null
}

/**
 * A session token is not compared here at all: its SHA-256 digest is the
 * indexed key the row is found by, so the comparison is Postgres's, on a
 * fixed-width digest, and a token that matches nothing costs one lookup. That
 * is why only the key path below needs a constant-time comparison — and why
 * `crypto-hygiene.test.ts` gates that one function.
 */
async function authenticateSession(pg: Pool, token: string, now: Date): Promise<Credential | null> {
  // The token's length is what a cookie can carry; the digest is fixed-width
  // whatever arrives, so a hostile cookie costs one indexed lookup.
  if (token.length === 0 || token.length > 200) return null
  const r = await pg.query<{ id: string; expires_at: Date; last_seen_at: Date }>(
    'SELECT id, expires_at, last_seen_at FROM sessions WHERE token_hash = $1',
    [hashToken(token)],
  )
  const row = r.rows[0]
  if (!row) return null
  const idleDeadline = row.last_seen_at.getTime() + SESSION_IDLE_MS
  if (row.expires_at.getTime() <= now.getTime() || idleDeadline <= now.getTime()) {
    // Gone rather than merely refused: a session that has run out is not
    // coming back, and leaving the row would let the same cookie be tried
    // against it forever.
    await pg.query('DELETE FROM sessions WHERE id = $1', [row.id])
    return null
  }
  if (now.getTime() - row.last_seen_at.getTime() >= TOUCH_INTERVAL_MS) {
    await pg.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.id, now])
  }
  return { kind: 'session', id: row.id }
}

async function authenticateKey(pg: Pool, presented: string, now: Date): Promise<Credential | null> {
  const parsed = parseApiKey(presented)
  if (!parsed) return null
  const r = await pg.query<{
    id: string
    secret_hash: string
    expires_at: Date | null
    revoked_at: Date | null
    last_used_at: Date | null
  }>('SELECT id, secret_hash, expires_at, revoked_at, last_used_at FROM api_keys WHERE id = $1', [
    parsed.id,
  ])
  const row = r.rows[0]
  if (!row) return null
  // Constant-time, and computed whether the key is revoked or not: an
  // attacker must not learn that an id exists from how long the answer took.
  const secretOk = digestsMatch(hashToken(parsed.secret), row.secret_hash)
  const live =
    row.revoked_at === null && (row.expires_at === null || row.expires_at.getTime() > now.getTime())
  if (!secretOk || !live) return null
  if (
    row.last_used_at === null ||
    now.getTime() - row.last_used_at.getTime() >= TOUCH_INTERVAL_MS
  ) {
    await pg.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [row.id, now])
  }
  return { kind: 'key', id: row.id }
}

/** The credential this request carries, or 401. */
export function requireCredential(req: FastifyRequest): Credential {
  const c = (req as FastifyRequest & { credential?: Credential }).credential
  if (!c) return fail(401, 'unauthenticated', 'sign in, or send an API key')
  return c
}

/**
 * A session, or 403 for an API key. Everything that touches a credential —
 * the password, TOTP, recovery codes, the session list, the keys themselves —
 * goes through here, so a stolen key can never widen itself.
 */
export function requireSession(req: FastifyRequest): Credential {
  const c = requireCredential(req)
  if (c.kind !== 'session') {
    fail(403, 'session_required', 'an API key cannot manage credentials; sign in')
  }
  return c
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The cross-site write guard.
 *
 * A request that changes something and carries a session cookie must say it
 * came from the admin origin, exactly. A browser sends `Origin` on every
 * cross-site request and on every non-GET of its own, so a missing `Origin`
 * on a write is refused too rather than waved through — "absent" is how the
 * classic bypass looks.
 *
 * A bearer key is exempt, and can be: a browser cannot attach an
 * `Authorization` header to a cross-site request without a preflight, and
 * this service answers no CORS headers at all, so no page on another origin
 * can make one that is read or accepted.
 */
export function checkCsrf(o: {
  method: string
  origin: string | undefined
  hasBearer: boolean
  adminHost: string
}): void {
  if (SAFE_METHODS.has(o.method.toUpperCase()) || o.hasBearer) return
  const expected = `https://${o.adminHost}`
  if (o.origin !== expected) {
    fail(403, 'bad_origin', `a write must come from ${expected}`)
  }
}

export function hasBearer(req: Pick<FastifyRequest, 'headers'>): boolean {
  return BEARER.test(String(req.headers.authorization ?? ''))
}
