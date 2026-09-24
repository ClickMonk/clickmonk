import { type ParsedLinkInput, newSlug } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'

/**
 * The one writer that creates a link.
 *
 * Two surfaces create links — the API and the command line — and a link is
 * where somebody's traffic is sent, so the statement that decides where it
 * goes exists once. It lives in this package rather than beside the API
 * because the runtime image carries this one and not that one, and the CLI
 * cannot import a package the image does not ship.
 *
 * What the two surfaces keep for themselves is how they *answer*: each
 * refusal below is reported in each caller's own words, with its own status
 * code or exit code. What they may not keep is the write.
 */

/**
 * Attempts to find an unused generated slug before giving up. Only a caller
 * that asked for a generated slug ever gets more than one: a slug somebody
 * typed is theirs, and a collision on it is a refusal rather than a different
 * link than the one they asked for.
 */
export const SLUG_ATTEMPTS = 5

export interface CreatedLink {
  id: string
  host: string
  /** The slug actually written, which is not the one asked for when it was generated and retried. */
  slug: string
}

export type CreateLinkResult =
  | { ok: true; link: CreatedLink }
  | { ok: false; reason: 'unknown_domain' }
  | { ok: false; reason: 'slug_taken'; slug: string }
  | { ok: false; reason: 'no_slug' }

/**
 * Writes a link and its targets in one transaction, or writes nothing.
 *
 * `link` has already been through `core`'s validator — both callers have to
 * parse it to build it, and both need that failure in their own shape long
 * before this point. A retried slug is not re-validated because a generated
 * one always matches the slug rule by construction.
 */
export async function createLink(
  pg: Pool,
  o: {
    /** Normalised by the caller, which refuses a bad one in its own words. */
    host: string
    link: ParsedLinkInput
    /**
     * The scrypt hash of the link's password, or null. Nothing hashes here:
     * the cost belongs to whoever knows what verifies it. Only the API sets
     * one; the command line has no way to.
     */
    passwordHash?: string | null
    /**
     * True when the slug in `link` was generated rather than typed, which is
     * the only case where a collision is tried again instead of refused.
     */
    generatedSlug?: boolean
    /**
     * Where a retry's slug comes from. Neither caller passes one: it exists so
     * that a collision, the retry, and giving up are all reachable from a test
     * without waiting for two random seven-character slugs to agree. An
     * unreachable branch in the one function that decides where traffic goes is
     * worse than an option nobody sets.
     */
    slugSource?: () => string
  },
): Promise<CreateLinkResult> {
  // Own properties, not inherited ones, for the three that decide something: a
  // property planted on `Object.prototype` would otherwise set a password on
  // every link written through here, turn a refusal into a link at a slug
  // nobody asked for, or choose the slug itself. `o` is an object literal a
  // caller builds, and a plain read of it walks the prototype chain.
  const passwordHash = (Object.hasOwn(o, 'passwordHash') ? o.passwordHash : null) ?? null
  const generated = Object.hasOwn(o, 'generatedSlug') && o.generatedSlug === true
  const nextSlug = (Object.hasOwn(o, 'slugSource') ? o.slugSource : undefined) ?? newSlug

  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const d = await client.query<{ id: string }>('SELECT id FROM domains WHERE host = $1', [o.host])
    const domainId = d.rows[0]?.id
    if (!domainId) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'unknown_domain' }
    }
    let slug = o.link.slug
    let id: string | undefined
    for (let attempt = 0; attempt < SLUG_ATTEMPTS && id === undefined; attempt++) {
      // The slug the caller built the link with is tried first; a generated
      // one that collided is replaced. `ON CONFLICT DO NOTHING` leaves the
      // transaction usable, so the next attempt is another statement rather
      // than another transaction.
      if (attempt > 0) slug = nextSlug()
      const l = await client.query<{ id: string }>(
        `INSERT INTO links (domain_id, slug, name, enabled, backup_url, device_urls,
                            returning_url, countries, click_cap, expires_at, passthrough,
                            traffic_actions, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (domain_id, slug) DO NOTHING RETURNING id`,
        [
          domainId,
          slug,
          o.link.name,
          o.link.enabled,
          o.link.backupUrl,
          JSON.stringify(o.link.deviceUrls),
          o.link.returningUrl,
          JSON.stringify(o.link.countries),
          o.link.clickCap,
          o.link.expiresAt,
          o.link.passthrough,
          JSON.stringify(o.link.trafficActions),
          passwordHash,
        ],
      )
      id = l.rows[0]?.id
      if (id === undefined && !generated) {
        await client.query('ROLLBACK')
        return { ok: false, reason: 'slug_taken', slug }
      }
    }
    if (id === undefined) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'no_slug' }
    }
    for (const [i, t] of o.link.targets.entries()) {
      await client.query(
        'INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, $2, $3, $4)',
        [id, t.url, t.weight, i],
      )
    }
    await client.query('COMMIT')
    return { ok: true, link: { id, host: o.host, slug } }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
