/**
 * Links over the API.
 *
 * Every write goes through `core`'s `parseLinkInput`, the same validator the
 * CLI uses, and a partial update re-validates the *whole* link rather than the
 * fields that changed: the redirect's snapshot validates what it loads, so a
 * link the API accepted but `core` would reject would simply not be served,
 * and the operator would hear nothing. Validating here with the same schema is
 * what turns that silence into a 400.
 *
 * A link's password is never returned, in any shape. The response says whether
 * one is set and nothing more — not its length, not a hint, not a hash.
 */
import {
  LINK_SCRYPT,
  MAX_PASSWORD_LENGTH,
  MIN_LINK_PASSWORD_LENGTH,
  type ParsedLinkInput,
  hashPassword,
  newSlug,
  normaliseHost,
  parseLinkInput,
} from '@clickmonk/core'
import type { PoolClient } from '@clickmonk/db'
import { createLink } from '@clickmonk/worker/links'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { fail, readBody } from './http.js'

/** Links in one page, and the ceiling a caller may ask for. */
export const DEFAULT_LINK_PAGE = 50
export const MAX_LINK_PAGE = 200

const LinkPassword = z.string().min(MIN_LINK_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH)

/**
 * The fields of a link, loose here and validated by `core` after they are
 * merged with what is stored: this schema's job is to bound what arrives and
 * to refuse a field nobody knows, not to restate the link rules.
 */
const LinkFields = {
  slug: z.string().max(64).optional(),
  name: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  targets: z
    .array(z.object({ url: z.string().max(2048), weight: z.number().int().optional() }).strict())
    .max(20)
    .optional(),
  backupUrl: z.string().max(2048).nullable().optional(),
  deviceUrls: z
    .object({
      ios: z.string().max(2048),
      android: z.string().max(2048),
      desktop: z.string().max(2048),
    })
    .partial()
    .strict()
    .optional(),
  returningUrl: z.string().max(2048).nullable().optional(),
  countries: z.unknown().optional(),
  clickCap: z.number().int().nullable().optional(),
  expiresAt: z.string().max(40).nullable().optional(),
  passthrough: z.boolean().optional(),
  trafficActions: z.record(z.string().max(20), z.string().max(20)).optional(),
  /** A string sets it, null clears it, absent leaves it alone. */
  password: LinkPassword.nullable().optional(),
}

const CreateBody = z.object({ host: z.string().min(1).max(253), ...LinkFields }).strict()
const PatchBody = z.object(LinkFields).strict()
const ListQuery = z
  .object({
    domain: z.string().max(253).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LINK_PAGE).default(DEFAULT_LINK_PAGE),
    /** The last id of the previous page. The order is by id: stable, arbitrary. */
    cursor: z.string().uuid().optional(),
  })
  .strict()

interface LinkRow {
  id: string
  domain_id: string
  host: string
  slug: string
  name: string | null
  enabled: boolean
  backup_url: string | null
  device_urls: Record<string, string>
  returning_url: string | null
  countries: unknown
  click_cap: string | null
  expires_at: Date | null
  passthrough: boolean
  traffic_actions: Record<string, string>
  password_hash: string | null
  targets: { id: string; url: string; weight: number }[] | null
}

const SELECT_LINKS = `SELECT l.id, l.domain_id, d.host, l.slug, l.name, l.enabled, l.backup_url,
                             l.device_urls, l.returning_url, l.countries, l.click_cap,
                             l.expires_at, l.passthrough, l.traffic_actions, l.password_hash,
                             json_agg(json_build_object('id', t.id, 'url', t.url, 'weight', t.weight)
                                      ORDER BY t.position)
                               FILTER (WHERE t.id IS NOT NULL) AS targets
                        FROM links l
                        JOIN domains d ON d.id = l.domain_id
                        LEFT JOIN link_targets t ON t.link_id = l.id`

/** What a link looks like over the API. The password appears only as a boolean. */
function asLink(l: LinkRow): Record<string, unknown> {
  return {
    id: l.id,
    domainId: l.domain_id,
    host: l.host,
    slug: l.slug,
    url: `https://${l.host}/${l.slug}`,
    name: l.name,
    enabled: l.enabled,
    targets: (l.targets ?? []).map((t) => ({ id: t.id, url: t.url, weight: t.weight })),
    backupUrl: l.backup_url,
    deviceUrls: l.device_urls,
    returningUrl: l.returning_url,
    countries: l.countries,
    clickCap: l.click_cap === null ? null : Number(l.click_cap),
    expiresAt: l.expires_at?.toISOString() ?? null,
    passthrough: l.passthrough,
    trafficActions: l.traffic_actions,
    hasPassword: l.password_hash !== null,
  }
}

/** The stored link as input to `core`'s validator, so a patch can be merged into it. */
function asInput(l: LinkRow): Record<string, unknown> {
  return {
    slug: l.slug,
    name: l.name,
    enabled: l.enabled,
    targets: (l.targets ?? []).map((t) => ({ url: t.url, weight: t.weight })),
    backupUrl: l.backup_url,
    deviceUrls: l.device_urls,
    returningUrl: l.returning_url,
    countries: l.countries,
    clickCap: l.click_cap === null ? null : Number(l.click_cap),
    expiresAt: l.expires_at === null ? null : l.expires_at.toISOString(),
    passthrough: l.passthrough,
    trafficActions: l.traffic_actions,
  }
}

/**
 * Anything a query can be sent through: the pool, or one client taken from it.
 *
 * Which one matters. A handler holding a client from a pool of four must not
 * ask that pool for a second one — it would wait behind itself, and four such
 * requests at once take the pool to zero with nobody left to release. So a
 * read that happens while a client is held is sent through that client.
 */
type Queryable = Pick<PoolClient, 'query'>

async function linkById(q: Queryable, id: string): Promise<LinkRow> {
  if (!z.string().uuid().safeParse(id).success) fail(404, 'not_found', 'no such link')
  const r = await q.query<LinkRow>(`${SELECT_LINKS} WHERE l.id = $1 GROUP BY l.id, d.host`, [id])
  const row = r.rows[0]
  if (!row) fail(404, 'not_found', 'no such link')
  return row as LinkRow
}

/**
 * A body as its own top-level properties and nothing else, with no prototype
 * behind it.
 *
 * Two reads here decide something: whether the caller named a slug, and
 * whether they mentioned the password — the second decides whether a stored
 * hash survives a patch. Both are answers about what the caller *wrote*, and a
 * plain object cannot give one on its own. A property planted on
 * `Object.prototype` is returned by `data[key]` and reported by `key in data`,
 * which is how zod decides a key was present: it reads the planted value and
 * copies it into its output as an own property, where a later `Object.hasOwn`
 * agrees that the caller sent it. So the prototype has to be stripped *before*
 * the parse and the own-property read has to happen after it; either half
 * alone answers nothing.
 *
 * It is shallow, deliberately: it covers the fields this module branches on.
 * Everything nested is validated by `core` against a strict schema rather than
 * decided here.
 */
function ownFields(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  return Object.assign(Object.create(null), body)
}

/**
 * The value the caller wrote for a field, or `undefined` when they did not
 * write it at all. The own-property half of the pair `ownFields` describes.
 */
function written<T, K extends keyof T & string>(body: T, key: K): T[K] | undefined {
  return Object.hasOwn(body as object, key) ? body[key] : undefined
}

/** Validates through `core`, and turns its ZodError into a 400 that names the field. */
function validate(input: unknown): ParsedLinkInput {
  try {
    return parseLinkInput(input)
  } catch (err) {
    // By name, not instanceof: the ZodError comes from core's copy of zod.
    if (err instanceof Error && err.name === 'ZodError') {
      const issues = (
        err as unknown as { issues: { path: (string | number)[]; message: string }[] }
      ).issues
        .map((i) => `${i.path.join('.') || 'link'}: ${i.message}`)
        .join('; ')
      return fail(400, 'invalid_link', issues)
    }
    throw err
  }
}

async function writeTargets(
  client: PoolClient,
  linkId: string,
  targets: ParsedLinkInput['targets'],
): Promise<void> {
  await client.query('DELETE FROM link_targets WHERE link_id = $1', [linkId])
  for (const [i, t] of targets.entries()) {
    await client.query(
      'INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, $2, $3, $4)',
      [linkId, t.url, t.weight, i],
    )
  }
}

export function registerLinkRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/links', async (req) => {
    requireCredential(req)
    const q = readBody(ListQuery, ownFields(req.query))
    const host = q.domain === undefined ? null : normaliseHost(q.domain)
    if (q.domain !== undefined && host === null) fail(400, 'invalid_host', 'not a valid host name')
    const r = await ctx.pg.query<LinkRow>(
      `${SELECT_LINKS}
        WHERE ($1::text IS NULL OR d.host = $1)
          AND ($2::uuid IS NULL OR l.id > $2)
        GROUP BY l.id, d.host
        ORDER BY l.id
        LIMIT $3`,
      [host, q.cursor ?? null, q.limit],
    )
    return {
      links: r.rows.map(asLink),
      // Present only when a further page may exist, so a caller stops rather
      // than asking forever.
      nextCursor: r.rows.length === q.limit ? (r.rows[r.rows.length - 1]?.id ?? null) : null,
    }
  })

  app.get<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    requireCredential(req)
    return asLink(await linkById(ctx.pg, req.params.id))
  })

  app.post('/api/links', async (req, reply) => {
    requireCredential(req)
    const body = readBody(CreateBody, ownFields(req.body))
    const host = normaliseHost(body.host)
    // `return fail(…)`, as the domain routes write it: a bare call does not
    // narrow `host` away from null, because the narrowing a never-returning
    // function gives depends on how its declaration is annotated.
    if (!host) return fail(400, 'invalid_host', 'not a valid host name')
    // Whether the caller named a slug decides whether a collision is their
    // problem or ours, so it is read with `written`, and the slug itself comes
    // from that same read rather than from a second one.
    const typedSlug = written(body, 'slug')
    const password = written(body, 'password')
    // LINK_SCRYPT, not the admin's cost: this hash is verified on the
    // redirect's own request path, where the attempt limiter is the bound.
    const passwordHash =
      password === undefined || password === null ? null : await hashPassword(password, LINK_SCRYPT)

    // `host` and `password` are this API's, not the link schema's, and that
    // schema is strict: a key present with an undefined value is still an
    // unknown key to it, so they are left out rather than blanked.
    const { host: _host, password: _password, ...fields } = body
    const link = validate(ownFields({ ...fields, slug: typedSlug ?? newSlug() }))
    // The write itself is one function, shared with the command line, because
    // a link decides where somebody's traffic goes and two copies of that
    // statement are two places for it to be got wrong. What stays here is how
    // this surface answers each refusal.
    const created = await createLink(ctx.pg, {
      host,
      link,
      passwordHash,
      // A slug the admin typed is theirs: a collision on it is a 409, never a
      // different slug than the one they asked for.
      generatedSlug: typedSlug === undefined,
    })
    if (!created.ok) {
      if (created.reason === 'unknown_domain') {
        fail(404, 'unknown_domain', `this install has no domain ${host}`)
      }
      if (created.reason === 'slug_taken') {
        fail(409, 'slug_taken', `${host} already has a link at ${created.slug}`)
      }
      return fail(503, 'no_slug', 'could not find an unused slug; try again')
    }
    return reply.code(201).send(asLink(await linkById(ctx.pg, created.link.id)))
  })

  app.patch<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    requireCredential(req)
    // The body first, as on the domain patch: a malformed body is a 400
    // whether the id exists or not.
    const body = readBody(PatchBody, ownFields(req.body))
    const existing = await linkById(ctx.pg, req.params.id)
    // Every stored field, then the ones this patch names over the top: what
    // `core` validates is the whole link as it will be, so a field nobody
    // mentioned keeps its stored value instead of falling back to a default.
    const merged: Record<string, unknown> = Object.assign(Object.create(null), asInput(existing))
    for (const [key, value] of Object.entries(body)) {
      if (key === 'password' || value === undefined) continue
      merged[key] = value
    }
    const input = validate(merged)
    // Absent leaves the password as it is; null clears it; a string replaces
    // it, which changes the hash and so stops every proof a visitor holds.
    // `written`, so that "absent" means the caller left it out.
    const password = written(body, 'password')
    const passwordHash =
      password === undefined
        ? existing.password_hash
        : password === null
          ? null
          : await hashPassword(password, LINK_SCRYPT)

    const client = await ctx.pg.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `UPDATE links SET slug = $2, name = $3, enabled = $4, backup_url = $5, device_urls = $6,
                          returning_url = $7, countries = $8, click_cap = $9, expires_at = $10,
                          passthrough = $11, traffic_actions = $12, password_hash = $13,
                          updated_at = $14
           WHERE id = $1`,
        [
          existing.id,
          input.slug,
          input.name,
          input.enabled,
          input.backupUrl,
          JSON.stringify(input.deviceUrls),
          input.returningUrl,
          JSON.stringify(input.countries),
          input.clickCap,
          input.expiresAt,
          input.passthrough,
          JSON.stringify(input.trafficActions),
          passwordHash,
          ctx.now(),
        ],
      )
      if ((r.rowCount ?? 0) === 0) fail(404, 'not_found', 'no such link')
      await writeTargets(client, existing.id, input.targets)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        fail(409, 'slug_taken', 'that slug is already used on this domain')
      }
      throw err
    } finally {
      client.release()
    }
    return asLink(await linkById(ctx.pg, existing.id))
  })

  app.delete<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    requireCredential(req)
    const existing = await linkById(ctx.pg, req.params.id)
    // Targets and the click counter go with it, by cascade.
    await ctx.pg.query('DELETE FROM links WHERE id = $1', [existing.id])
    return { ok: true }
  })
}
