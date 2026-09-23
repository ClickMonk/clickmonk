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

const CreateBody = z
  .object({
    name: z.string().min(1).max(100),
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

/**
 * Stores a key and returns what the admin has to copy now. Shared with the
 * CLI's `apikey create`, so there is one place that decides what is stored.
 */
export async function createApiKey(
  pg: Pool,
  o: { name: string; expiresAt: Date | null; now: Date },
): Promise<CreatedKey> {
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
      body.expiresDays === undefined
        ? null
        : new Date(now.getTime() + body.expiresDays * 24 * 60 * 60 * 1000)
    const created = await createApiKey(ctx.pg, { name: body.name, expiresAt, now })
    // 201, and the only time the key itself appears in a response body.
    return reply.code(201).send(created)
  })

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (req) => {
    requireSession(req)
    if (!/^[0-9a-f]{16}$/.test(req.params.id)) fail(404, 'not_found', 'no such key')
    if (!(await revokeApiKey(ctx.pg, req.params.id, ctx.now()))) {
      fail(404, 'not_found', 'no such key, or it was already revoked')
    }
    return { ok: true }
  })
}
