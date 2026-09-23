import { LINK_SCRYPT, SCRYPT_PREFIX, verifyPassword } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_LINK_PAGE } from './links.js'
import { clockFrom, read, signedIn, testApp, write } from './testing.js'

const pg = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-23T10:00:00.000Z'))
let app: FastifyInstance
let cookie = ''

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

beforeEach(async () => {
  clock.set(new Date('2026-09-23T10:00:00.000Z'))
  await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  await pg.query('TRUNCATE domains CASCADE')
  app = testApp(pg, clock)
  cookie = await signedIn(app, pg)
  await app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: write(cookie),
    payload: { host: 'go.example.test' },
  })
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

const create = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/links',
    headers: write(cookie),
    payload: { host: 'go.example.test', ...payload },
  })

const target = { url: 'https://example.com/offer' }

describe('creating a link', () => {
  it('stores it with its targets and answers where it lives', async () => {
    const r = await create({ slug: 'spring', targets: [target], name: 'Spring sale' })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body.slug).toBe('spring')
    expect(body.url).toBe('https://go.example.test/spring')
    expect(body.targets).toEqual([{ id: expect.any(String), url: target.url, weight: 100 }])
    expect(body.hasPassword).toBe(false)
    const stored = await pg.query<{ position: number; weight: number }>(
      'SELECT position, weight FROM link_targets',
    )
    expect(stored.rows).toEqual([{ position: 0, weight: 100 }])
  })

  it('generates a slug when none is given', async () => {
    const r = await create({ targets: [target] })
    expect(r.statusCode).toBe(201)
    expect(r.json().slug).toMatch(/^[A-Za-z0-9]{7}$/)
  })

  it('refuses a slug that is taken, rather than replacing the link or picking another', async () => {
    expect((await create({ slug: 'spring', targets: [target] })).statusCode).toBe(201)
    const again = await create({ slug: 'spring', targets: [target] })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('slug_taken')
    expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(1)
  })

  it('refuses a domain this install does not have', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: write(cookie),
      payload: { host: 'other.example.test', targets: [target] },
    })
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toBe('unknown_domain')
    // The refusal is only half of it: a handler that inserted and then
    // refused would answer 404 with the link already stored.
    expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
  })

  // The same validator the CLI uses and the snapshot loader trusts. A link the
  // API accepted but core would reject would not be served at all, and the
  // operator would hear nothing about it.
  it.each([
    ['no targets', { targets: [] }],
    ['a target that is not a URL', { targets: [{ url: 'not a url' }] }],
    ['a javascript URL', { targets: [{ url: 'javascript:alert(1)' }] }],
    ['a non-ASCII destination', { targets: [{ url: 'https://example.com/café' }] }],
    ['a token in the host', { targets: [{ url: 'https://{param:h}/x' }] }],
    [
      'weights that do not sum to 100',
      {
        targets: [
          { url: target.url, weight: 40 },
          { url: 'https://example.com/b', weight: 40 },
        ],
      },
    ],
    [
      'a weight missing from one of several',
      { targets: [{ url: target.url, weight: 100 }, { url: 'https://example.com/b' }] },
    ],
    ['a slug with a slash', { slug: 'a/b', targets: [target] }],
    [
      'a country that is not an alpha-2 code',
      { targets: [target], countries: { mode: 'allow', list: ['usa'] } },
    ],
    ['a traffic action nobody knows', { targets: [target], trafficActions: { bot: 'drop' } }],
    ['a class nobody knows', { targets: [target], trafficActions: { human: 'flag' } }],
    ['a cap of zero', { targets: [target], clickCap: 0 }],
    ['21 targets', { targets: Array.from({ length: 21 }, () => ({ url: target.url, weight: 5 })) }],
  ])('refuses %s', async (_label, payload) => {
    const r = await create(payload)
    expect(r.statusCode).toBe(400)
    expect(['invalid_link', 'invalid_body']).toContain(r.json().error)
    expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
  })

  // `invalid_body`, not merely 400: the body schema is what must refuse these,
  // and it has to be checked by name. A body that let an unknown field through
  // reaches core's own strict schema and is refused there instead — a 400 with
  // a different code, which a test that only read the status would accept,
  // leaving the field this API never wants to see written into the link input.
  it.each(['domainId', 'accountId', 'adminId', 'passwordHash'])(
    'refuses a body carrying %s, a field nobody knows',
    async (field) => {
      const r = await create({ targets: [target], [field]: 'anything at all' })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('invalid_body')
      expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
    },
  )

  it('refuses a patch carrying a field nobody knows', async () => {
    const created = (await create({ slug: 'spring', targets: [target] })).json()
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { name: 'Spring', passwordHash: 'anything at all' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    const after = await pg.query<{ name: string | null; password_hash: string | null }>(
      'SELECT name, password_hash FROM links',
    )
    expect(after.rows).toEqual([{ name: null, password_hash: null }])
  })
})

describe('a link password', () => {
  it('is stored hashed and never comes back', async () => {
    const r = await create({ slug: 'secret', targets: [target], password: 'spring2026' })
    expect(r.statusCode).toBe(201)
    expect(r.json().hasPassword).toBe(true)
    expect(JSON.stringify(r.json())).not.toContain('spring2026')
    const stored = await pg.query<{ password_hash: string }>('SELECT password_hash FROM links')
    const hash = stored.rows[0]?.password_hash as string
    // The frame, and the link's own cost — not the admin's.
    expect(hash.startsWith(`${SCRYPT_PREFIX}$${LINK_SCRYPT.N}$`)).toBe(true)
    expect(await verifyPassword('spring2026', hash)).toBe(true)
    const got = await app.inject({
      method: 'GET',
      url: `/api/links/${r.json().id}`,
      headers: read(cookie),
    })
    expect(JSON.stringify(got.json())).not.toContain(SCRYPT_PREFIX)
    expect(JSON.stringify(got.json())).not.toContain(hash)
  })

  it('is replaced by a new one, and a new hash, so old proofs stop working', async () => {
    const created = (await create({ targets: [target], password: 'spring2026' })).json()
    const first = (await pg.query<{ password_hash: string }>('SELECT password_hash FROM links'))
      .rows[0]?.password_hash as string
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { password: 'summer2026' },
    })
    expect(patched.statusCode).toBe(200)
    const second = (await pg.query<{ password_hash: string }>('SELECT password_hash FROM links'))
      .rows[0]?.password_hash as string
    expect(second).not.toBe(first)
    expect(await verifyPassword('summer2026', second)).toBe(true)
    expect(await verifyPassword('spring2026', second)).toBe(false)
  })

  it('is left alone by a patch that does not mention it, and cleared by null', async () => {
    const created = (await create({ targets: [target], password: 'spring2026' })).json()
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { name: 'Spring' },
    })
    expect(renamed.json().hasPassword).toBe(true)
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { password: null },
    })
    expect(cleared.json().hasPassword).toBe(false)
    expect(
      (await pg.query<{ password_hash: string | null }>('SELECT password_hash FROM links')).rows[0]
        ?.password_hash,
    ).toBeNull()
  })

  it('refuses one shorter than the floor', async () => {
    const r = await create({ targets: [target], password: 'short' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    // Refused, and no link behind it carrying a password nobody can use.
    expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
  })
})

describe('changing a link', () => {
  it('validates the whole link, not only the fields that changed', async () => {
    const created = (
      await create({
        targets: [
          { url: target.url, weight: 50 },
          { url: 'https://example.com/b', weight: 50 },
        ],
      })
    ).json()
    // One target with a weight of 50 would leave the link's weights at 50.
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { targets: [{ url: target.url, weight: 50 }] },
    })
    // A single target is normalised to 100 by core, so this one is accepted...
    expect(r.statusCode).toBe(200)
    expect(r.json().targets).toEqual([{ id: expect.any(String), url: target.url, weight: 100 }])
    // ...while a pair that does not sum to 100 is refused, and nothing changed.
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: {
        targets: [
          { url: target.url, weight: 10 },
          { url: 'https://example.com/b', weight: 10 },
        ],
      },
    })
    expect(bad.statusCode).toBe(400)
    const after = await app.inject({
      method: 'GET',
      url: `/api/links/${created.id}`,
      headers: read(cookie),
    })
    expect(after.json().targets).toHaveLength(1)
  })

  it('replaces the targets in order, leaving none behind', async () => {
    const created = (await create({ targets: [target] })).json()
    await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: {
        targets: [
          { url: 'https://example.com/a', weight: 30 },
          { url: 'https://example.com/b', weight: 70 },
        ],
      },
    })
    const rows = await pg.query<{ url: string; position: number }>(
      'SELECT url, position FROM link_targets ORDER BY position',
    )
    expect(rows.rows).toEqual([
      { url: 'https://example.com/a', position: 0 },
      { url: 'https://example.com/b', position: 1 },
    ])
  })

  it('refuses a slug another link on the domain already has, and keeps both as they were', async () => {
    const one = (await create({ slug: 'one', targets: [target] })).json()
    const two = (await create({ slug: 'two', targets: [{ url: 'https://example.com/b' }] })).json()
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/links/${two.id}`,
      headers: write(cookie),
      payload: { slug: 'one' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('slug_taken')
    const slugs = await pg.query<{ id: string; slug: string }>('SELECT id, slug FROM links')
    expect(new Map(slugs.rows.map((l) => [l.id, l.slug]))).toEqual(
      new Map([
        [one.id, 'one'],
        [two.id, 'two'],
      ]),
    )
  })

  it('takes its targets and counter with it when deleted', async () => {
    const created = (await create({ targets: [target], clickCap: 10 })).json()
    await pg.query('INSERT INTO link_counters (link_id, clicks) VALUES ($1, 3)', [created.id])
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect((await pg.query('SELECT 1 FROM link_targets')).rowCount).toBe(0)
    expect((await pg.query('SELECT 1 FROM link_counters')).rowCount).toBe(0)
  })
})

describe('listing links', () => {
  it('pages, bounded, and stops rather than offering a cursor forever', async () => {
    for (let i = 0; i < 5; i++) await create({ slug: `link-${i}`, targets: [target] })
    const first = await app.inject({
      method: 'GET',
      url: '/api/links?limit=2',
      headers: read(cookie),
    })
    expect(first.json().links).toHaveLength(2)
    const second = await app.inject({
      method: 'GET',
      url: `/api/links?limit=2&cursor=${first.json().nextCursor}`,
      headers: read(cookie),
    })
    expect(second.json().links).toHaveLength(2)
    const seen = [...first.json().links, ...second.json().links].map(
      (l: { slug: string }) => l.slug,
    )
    expect(new Set(seen).size).toBe(4)
    const last = await app.inject({
      method: 'GET',
      url: `/api/links?limit=2&cursor=${second.json().nextCursor}`,
      headers: read(cookie),
    })
    expect(last.json().links).toHaveLength(1)
    expect(last.json().nextCursor).toBeNull()
  })

  it('refuses a page larger than the bound, and a cursor that is not an id', async () => {
    const tooBig = await app.inject({
      method: 'GET',
      url: `/api/links?limit=${MAX_LINK_PAGE + 1}`,
      headers: read(cookie),
    })
    expect(tooBig.statusCode).toBe(400)
    const badCursor = await app.inject({
      method: 'GET',
      url: '/api/links?cursor=not-a-uuid',
      headers: read(cookie),
    })
    expect(badCursor.statusCode).toBe(400)
  })

  it('filters by domain', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: write(cookie),
      payload: { host: 'two.example.test' },
    })
    await create({ slug: 'one', targets: [target] })
    await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: write(cookie),
      payload: { host: 'two.example.test', slug: 'two', targets: [target] },
    })
    const r = await app.inject({
      method: 'GET',
      url: '/api/links?domain=two.example.test',
      headers: read(cookie),
    })
    expect(r.json().links.map((l: { slug: string }) => l.slug)).toEqual(['two'])
  })
})

/**
 * A credential is the only thing between a stranger and every link this
 * install serves. One row per route, so removing one handler's call fails
 * that row alone — and each write row reads back the state it would have
 * changed, because a handler that acts and *then* refuses also answers 401.
 */
describe('every route needs a credential', () => {
  interface Anonymous {
    name: string
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    path: string
    payload?: Record<string, unknown>
    unchanged?: (id: string) => Promise<void>
  }

  const anonymous: Anonymous[] = [
    { name: 'GET /api/links', method: 'GET', path: '/api/links' },
    { name: 'GET /api/links/:id', method: 'GET', path: '/api/links/:id' },
    {
      name: 'POST /api/links',
      method: 'POST',
      path: '/api/links',
      payload: {
        host: 'go.example.test',
        slug: 'anon',
        targets: [{ url: 'https://example.com/x' }],
      },
      unchanged: async () => {
        expect((await pg.query('SELECT 1 FROM links WHERE slug = $1', ['anon'])).rowCount).toBe(0)
      },
    },
    {
      name: 'PATCH /api/links/:id',
      method: 'PATCH',
      path: '/api/links/:id',
      payload: { name: 'taken over' },
      unchanged: async (id) => {
        const r = await pg.query<{ name: string | null }>('SELECT name FROM links WHERE id = $1', [
          id,
        ])
        expect(r.rows[0]?.name).toBe('Spring sale')
      },
    },
    {
      name: 'DELETE /api/links/:id',
      method: 'DELETE',
      path: '/api/links/:id',
      unchanged: async (id) => {
        expect((await pg.query('SELECT 1 FROM links WHERE id = $1', [id])).rowCount).toBe(1)
      },
    },
  ]

  it.each(anonymous)('refuses an anonymous $name, and changes nothing', async (row) => {
    const created = (
      await create({ slug: 'spring', targets: [target], name: 'Spring sale' })
    ).json()
    const r = await app.inject({
      method: row.method,
      url: row.path.replace(':id', created.id),
      // Everything a request can carry except a credential: the right host,
      // and an `Origin` the cross-site check accepts.
      headers: write(),
      ...(row.payload ? { payload: row.payload } : {}),
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
    // The refusal and nothing else: no listing, no link, no password flag.
    expect(Object.keys(r.json()).sort()).toEqual(['error', 'message'])
    await row.unchanged?.(created.id)
  })
})
