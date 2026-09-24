/**
 * API keys: minted by a signed-in admin, presented as
 * `Authorization: Bearer cmk_<id>_<secret>`, and never able to touch a
 * credential — not even their own creation. Managing keys needs a session, so
 * a stolen key cannot mint a second one that outlives its revocation.
 */
import { type NewApiKey, hashToken, newApiKey } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireSession } from './auth.js'
import { fail, readBody } from './http.js'

/** Keys listed at once, and the longest life a new one may be given. */
export const MAX_KEYS_LISTED = 200
export const MAX_KEY_DAYS = 3650
/** As long a name as the column takes; one number, enforced in both places. */
export const MAX_KEY_NAME_LENGTH = 100

const CreateBody = z
  .object({
    name: z.string().min(1).max(MAX_KEY_NAME_LENGTH),
    /** Omitted: the key does not expire until it is revoked. */
    expiresDays: z.number().int().min(1).max(MAX_KEY_DAYS).optional(),
  })
  .strict()

export interface CreatedKey {
  id: string
  name: string
  /** Shown once: this is never stored, only its digest is. */
  key: string
  expiresAt: string | null
}

/** A day, in milliseconds: the unit both the route and the bound below count in. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Stores a key and returns what the admin has to copy now. Shared with the
 * CLI, so there is one place that decides what is stored.
 *
 * The bounds are here rather than only in the route's schema because this
 * function has callers with no schema in front of them. Without them a caller
 * that is not an HTTP request could store a key that never meaningfully
 * expires, or a name the column refuses — which surfaces as a raw constraint
 * violation rather than as a refusal that says what was wrong. The route's own
 * schema still rejects the same values first, so nothing it answers changes.
 */
export async function createApiKey(
  pg: Pool,
  o: { name: string; expiresAt: Date | null; now: Date },
): Promise<CreatedKey> {
  if (o.name.length < 1 || o.name.length > MAX_KEY_NAME_LENGTH) {
    fail(400, 'invalid_key', `a key's name is 1 to ${MAX_KEY_NAME_LENGTH} characters`)
  }
  if (o.expiresAt !== null) {
    if (o.expiresAt.getTime() <= o.now.getTime()) {
      fail(400, 'invalid_key', 'a key that has already expired is not worth storing')
    }
    if (o.expiresAt.getTime() > o.now.getTime() + MAX_KEY_DAYS * DAY_MS) {
      fail(400, 'invalid_key', `a key lives at most ${MAX_KEY_DAYS} days`)
    }
  }
  const key: NewApiKey = newApiKey()
  await pg.query(
    'INSERT INTO api_keys (id, name, secret_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [key.id, o.name, hashToken(key.secret), o.now, o.expiresAt],
  )
  return {
    id: key.id,
    name: o.name,
    key: key.display,
    expiresAt: o.expiresAt?.toISOString() ?? null,
  }
}

export interface KeyRow {
  id: string
  name: string
  created_at: Date
  last_used_at: Date | null
  expires_at: Date | null
  revoked_at: Date | null
}

/**
 * A page of keys, and whether there were more. The cap stays — a key list does
 * not grow the way a link list does — but a caller shown a prefix must be told
 * it was a prefix, or it silently manages the wrong set. One row past the cap
 * is asked for and dropped, which is what makes `truncated` exact rather than
 * "the page was full, so probably".
 */
export async function listApiKeys(pg: Pool): Promise<{ keys: KeyRow[]; truncated: boolean }> {
  const r = await pg.query<KeyRow>(
    `SELECT id, name, created_at, last_used_at, expires_at, revoked_at
       FROM api_keys ORDER BY created_at DESC, id LIMIT ${MAX_KEYS_LISTED + 1}`,
  )
  return { keys: r.rows.slice(0, MAX_KEYS_LISTED), truncated: r.rows.length > MAX_KEYS_LISTED }
}

/** Revokes a key. Idempotent: revoking a revoked key leaves the first time it happened. */
export async function revokeApiKey(pg: Pool, id: string, now: Date): Promise<boolean> {
  const r = await pg.query(
    'UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
    [id, now],
  )
  return (r.rowCount ?? 0) > 0
}

const asKey = (k: KeyRow): Record<string, string | null> => ({
  id: k.id,
  name: k.name,
  createdAt: k.created_at.toISOString(),
  lastUsedAt: k.last_used_at?.toISOString() ?? null,
  expiresAt: k.expires_at?.toISOString() ?? null,
  revokedAt: k.revoked_at?.toISOString() ?? null,
})

export function registerKeyRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/keys', async (req) => {
    requireSession(req)
    const { keys, truncated } = await listApiKeys(ctx.pg)
    return { keys: keys.map(asKey), truncated }
  })

  app.post('/api/keys', async (req, reply) => {
    requireSession(req)
    const body = readBody(CreateBody, req.body)
    const now = ctx.now()
    const expiresAt =
      body.expiresDays === undefined ? null : new Date(now.getTime() + body.expiresDays * DAY_MS)
    const created = await createApiKey(ctx.pg, { name: body.name, expiresAt, now })
    // 201, and the only time the key itself appears in a response body.
    return reply.code(201).send(created)
  })

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (req) => {
    // A session, like every other route that touches a credential: revoking is
    // the destructive half of managing keys, and a bearer request skips the
    // cross-site check, so this call is the only thing stopping a stolen key
    // from revoking every other key on the install.
    requireSession(req)
    // No shape check on the id: the column only holds sixteen hex characters,
    // so anything else matches no row and takes the same 404 as an id that is
    // merely unknown. A guard that changes no outcome is one more thing to
    // disprove later.
    if (!(await revokeApiKey(ctx.pg, req.params.id, ctx.now()))) {
      fail(404, 'not_found', 'no such key, or it was already revoked')
    }
    return { ok: true }
  })
}
