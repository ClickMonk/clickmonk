import { LINK_SCRYPT, hashPassword, parseLinkInput } from '@clickmonk/core'
import { createPgPool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDomain } from './domains.js'
import { SLUG_ATTEMPTS, createLink } from './links.js'

const pool = testPg()
const ch = testCh()
const host = 'go.example.test'

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

beforeEach(async () => {
  await pool.query('TRUNCATE domains CASCADE')
  await createDomain(pool, { host })
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

const link = (fields: Record<string, unknown> = {}) =>
  parseLinkInput({ slug: 'spring', targets: [{ url: 'https://example.com/offer' }], ...fields })

const links = () =>
  pool.query<{ slug: string; password_hash: string | null }>(
    'SELECT slug, password_hash FROM links ORDER BY slug',
  )

describe('the one writer for a link', () => {
  it('writes the link and its targets, and says what it wrote', async () => {
    const r = await createLink(pool, {
      host,
      link: link({
        targets: [
          { url: 'https://example.com/a', weight: 40 },
          { url: 'https://example.com/b', weight: 60 },
        ],
      }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link.host).toBe(host)
    expect(r.link.slug).toBe('spring')
    const targets = await pool.query<{ url: string; weight: number; position: number }>(
      'SELECT url, weight, position FROM link_targets WHERE link_id = $1 ORDER BY position',
      [r.link.id],
    )
    expect(targets.rows).toEqual([
      { url: 'https://example.com/a', weight: 40, position: 0 },
      { url: 'https://example.com/b', weight: 60, position: 1 },
    ])
  })

  it('stores the hash it is handed, and null when it is handed none', async () => {
    const hash = await hashPassword('spring2026', LINK_SCRYPT)
    expect((await createLink(pool, { host, link: link(), passwordHash: hash })).ok).toBe(true)
    expect((await createLink(pool, { host, link: link({ slug: 'plain' }) })).ok).toBe(true)
    const rows = await links()
    expect(rows.rows).toEqual([
      { slug: 'plain', password_hash: null },
      { slug: 'spring', password_hash: hash },
    ])
  })

  it('refuses a domain this install does not have, and writes nothing', async () => {
    const r = await createLink(pool, { host: 'nowhere.example.test', link: link() })
    expect(r).toEqual({ ok: false, reason: 'unknown_domain' })
    expect((await links()).rowCount).toBe(0)
  })

  it('refuses a slug that is taken, and writes nothing', async () => {
    expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    const again = await createLink(pool, {
      host,
      link: link({ targets: [{ url: 'https://example.com/other' }] }),
    })
    expect(again).toEqual({ ok: false, reason: 'slug_taken', slug: 'spring' })
    expect((await links()).rowCount).toBe(1)
    // The first link's target, not a second one written before the refusal.
    expect((await pool.query('SELECT 1 FROM link_targets')).rowCount).toBe(1)
  })

  it('tries another slug past a collision when the slug was generated', async () => {
    expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    const r = await createLink(pool, {
      host,
      link: link(),
      generatedSlug: true,
      slugSource: () => 'summer',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link.slug).toBe('summer')
    expect((await links()).rows.map((l) => l.slug)).toEqual(['spring', 'summer'])
  })

  it('gives up after a bounded number of attempts, and writes nothing', async () => {
    expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    let asked = 0
    const r = await createLink(pool, {
      host,
      link: link(),
      generatedSlug: true,
      // Every attempt lands on the slug that is already taken.
      slugSource: () => {
        asked++
        return 'spring'
      },
    })
    expect(r).toEqual({ ok: false, reason: 'no_slug' })
    // The slug the caller arrived with is the first attempt; the source supplies
    // the rest, so it is asked one fewer time than there are attempts.
    expect(asked).toBe(SLUG_ATTEMPTS - 1)
    expect((await links()).rowCount).toBe(1)
  })

  it('hands the client back with no transaction open when it gives up', async () => {
    // A pool of one, so the connection the writer used is the connection read
    // back. Its state is read through the other pool: asking this one would be
    // another statement inside the transaction under test.
    const tight = createPgPool(TEST_PG_URL, { max: 1, connectTimeoutMs: 1000 })
    try {
      expect((await createLink(tight, { host, link: link() })).ok).toBe(true)
      const pid = (await tight.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      const r = await createLink(tight, {
        host,
        link: link(),
        generatedSlug: true,
        slugSource: () => 'spring',
      })
      expect(r).toEqual({ ok: false, reason: 'no_slug' })
      const state = await pool.query<{ state: string }>(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
      expect(state.rows[0]?.state).toBe('idle')
    } finally {
      // Defensive, and only for the failing case: a connection this test found
      // still inside a transaction would hold locks that the next test's
      // TRUNCATE waits for, turning one clean assertion failure into a suite
      // that hangs.
      await tight.query('ROLLBACK').catch(() => {})
      await tight.end()
    }
  })
})

/**
 * Three options decide something here, and each is read as an own property of
 * the object the caller built. One row per option, so deleting one guard fails
 * one row: a property planted on `Object.prototype` answers for every caller
 * that said nothing about it.
 */
describe('an option nobody passed', () => {
  const plant = (key: string, value: unknown): void => {
    Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  }
  const unplant = (key: string): void => {
    // A computed key, so `delete` here is not the shape the linter objects to.
    delete (Object.prototype as unknown as Record<string, unknown>)[key]
  }

  it('sets no password from a planted passwordHash', async () => {
    const hash = await hashPassword('spring2026', LINK_SCRYPT)
    plant('passwordHash', hash)
    try {
      expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    } finally {
      unplant('passwordHash')
    }
    expect((await links()).rows[0]?.password_hash).toBeNull()
  })

  it('still refuses a taken slug with a planted generatedSlug', async () => {
    expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    plant('generatedSlug', true)
    try {
      const again = await createLink(pool, { host, link: link() })
      expect(again).toEqual({ ok: false, reason: 'slug_taken', slug: 'spring' })
    } finally {
      unplant('generatedSlug')
    }
    expect((await links()).rowCount).toBe(1)
  })

  it('draws a retry from its own generator, not a planted slugSource', async () => {
    expect((await createLink(pool, { host, link: link() })).ok).toBe(true)
    plant('slugSource', () => 'planted')
    let slug = ''
    try {
      const r = await createLink(pool, { host, link: link(), generatedSlug: true })
      expect(r.ok).toBe(true)
      if (r.ok) slug = r.link.slug
    } finally {
      unplant('slugSource')
    }
    expect(slug).not.toBe('planted')
    expect((await links()).rows.map((l) => l.slug)).toEqual(['spring', slug].sort())
  })
})
