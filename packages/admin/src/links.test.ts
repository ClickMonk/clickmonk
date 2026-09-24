import { LINK_SCRYPT, SCRYPT_PREFIX, verifyPassword } from '@clickmonk/core'
import { createPgPool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_LINK_PAGE, ownFields } from './links.js'
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
  cookie = await signedIn(app, pg, clock.now())
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

  // The generated-slug path ends somewhere when every attempt collides, and
  // what it ends in is this service's own answer rather than the writer's
  // reason. Driven by handing the app a slug source that only ever offers a
  // slug that is taken; nothing in the product passes one.
  it('answers 503 when it cannot find a free slug, and writes nothing', async () => {
    const crowded = testApp(pg, clock, { slugSource: () => 'crowded' })
    try {
      const first = await crowded.inject({
        method: 'POST',
        url: '/api/links',
        headers: write(cookie),
        payload: { host: 'go.example.test', targets: [target] },
      })
      expect(first.statusCode).toBe(201)
      expect(first.json().slug).toBe('crowded')
      const r = await crowded.inject({
        method: 'POST',
        url: '/api/links',
        headers: write(cookie),
        payload: { host: 'go.example.test', targets: [target] },
      })
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('no_slug')
      expect(Object.keys(r.json()).sort()).toEqual(['error', 'message'])
      // The refusal, and no second link at a slug nobody would have asked for.
      expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(1)
    } finally {
      await crowded.close()
    }
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
  //
  // Each row names the code it expects, because the two schemas answer
  // differently and which one refused is the point: `invalid_link` is core's,
  // `invalid_body` is this module's own bound in front of it. Accepting either
  // would let a row move from one schema to the other — the bound in front
  // dropped, the rule behind it doing the work — without a test noticing.
  it.each([
    { what: 'no targets', payload: { targets: [] }, error: 'invalid_link' },
    {
      what: 'a target that is not a URL',
      payload: { targets: [{ url: 'not a url' }] },
      error: 'invalid_link',
    },
    {
      what: 'a javascript URL',
      payload: { targets: [{ url: 'javascript:alert(1)' }] },
      error: 'invalid_link',
    },
    {
      what: 'a non-ASCII destination',
      payload: { targets: [{ url: 'https://example.com/café' }] },
      error: 'invalid_link',
    },
    {
      what: 'a token in the host',
      payload: { targets: [{ url: 'https://{param:h}/x' }] },
      error: 'invalid_link',
    },
    {
      what: 'weights that do not sum to 100',
      payload: {
        targets: [
          { url: target.url, weight: 40 },
          { url: 'https://example.com/b', weight: 40 },
        ],
      },
      error: 'invalid_link',
    },
    {
      what: 'a weight missing from one of several',
      payload: { targets: [{ url: target.url, weight: 100 }, { url: 'https://example.com/b' }] },
      error: 'invalid_link',
    },
    {
      what: 'a slug with a slash',
      payload: { slug: 'a/b', targets: [target] },
      error: 'invalid_link',
    },
    {
      what: 'a country that is not an alpha-2 code',
      payload: { targets: [target], countries: { mode: 'allow', list: ['usa'] } },
      error: 'invalid_link',
    },
    {
      what: 'a traffic action nobody knows',
      payload: { targets: [target], trafficActions: { bot: 'drop' } },
      error: 'invalid_link',
    },
    {
      what: 'a class nobody knows',
      payload: { targets: [target], trafficActions: { human: 'flag' } },
      error: 'invalid_link',
    },
    { what: 'a cap of zero', payload: { targets: [target], clickCap: 0 }, error: 'invalid_link' },
    {
      what: '21 targets',
      payload: { targets: Array.from({ length: 21 }, () => ({ url: target.url, weight: 5 })) },
      // This module's own cap, refused before core is asked: 21 never reaches
      // the validator, and the body bound is what says so.
      error: 'invalid_body',
    },
  ])('refuses $what', async ({ payload, error }) => {
    const r = await create(payload)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe(error)
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

  it('keeps every stored field a patch does not mention', async () => {
    const expiresAt = new Date(clock.now().getTime() + 86_400_000).toISOString()
    const created = (
      await create({
        slug: 'full',
        targets: [target],
        enabled: false,
        clickCap: 500,
        countries: { mode: 'allow', list: ['US', 'GB'] },
        expiresAt,
        backupUrl: 'https://example.com/backup',
        returningUrl: 'https://example.com/again',
        passthrough: false,
        trafficActions: { bot: 'block' },
      })
    ).json()
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/links/${created.id}`,
      headers: write(cookie),
      payload: { name: 'Renamed' },
    })
    expect(r.statusCode).toBe(200)
    // Read back from the row, field by field: a merge that dropped what the
    // patch did not mention answers 200 with ten fields quietly back at the
    // validator's defaults — enabled, passthrough and the rest.
    const body = r.json()
    expect(body.name).toBe('Renamed')
    expect(body.slug).toBe('full')
    expect(body.enabled).toBe(false)
    expect(body.clickCap).toBe(500)
    expect(body.countries).toEqual({ mode: 'allow', list: ['US', 'GB'] })
    expect(body.expiresAt).toBe(expiresAt)
    expect(body.backupUrl).toBe('https://example.com/backup')
    expect(body.returningUrl).toBe('https://example.com/again')
    expect(body.passthrough).toBe(false)
    expect(body.trafficActions).toEqual({ bot: 'block' })
    expect(body.targets).toEqual([{ id: expect.any(String), url: target.url, weight: 100 }])
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
    // The code and the whole body, because the interesting failure is a 500:
    // a bound the schema no longer applies sends the value on to Postgres,
    // which raises, and the route answers 500 — a refusal of a kind, and not
    // this one. A test that read only "it did not work" would accept it.
    expect(tooBig.json().error).toBe('invalid_body')
    expect(Object.keys(tooBig.json()).sort()).toEqual(['error', 'message'])
    const badCursor = await app.inject({
      method: 'GET',
      url: '/api/links?cursor=not-a-uuid',
      headers: read(cookie),
    })
    expect(badCursor.statusCode).toBe(400)
    expect(badCursor.json().error).toBe('invalid_body')
    expect(Object.keys(badCursor.json()).sort()).toEqual(['error', 'message'])
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
 * The rebuild copies **own** properties, and that choice is not observable
 * through any route, which is why it is tested here directly.
 *
 * Above it, two things decide an enumerable planted property before this code
 * can: the framework copies one into an own property of `req.query` while
 * parsing a query string, so by the time a route sees it, it is
 * indistinguishable from something the caller sent; and a schema marked strict
 * settles its unrecognised keys with `for…in`, which walks the prototype, so an
 * enumerable planted key on a body is refused there. A plain assignment to
 * `Object.prototype` — the shape pollution actually has — is therefore
 * unreachable from outside, and only this test can say which properties the
 * rebuild copies.
 */
describe('the rebuild itself', () => {
  it('copies own properties, and not what the prototype offers', () => {
    Object.defineProperty(Object.prototype, 'planted', {
      value: 'from the prototype',
      configurable: true,
      writable: true,
      // Enumerable: what an assignment produces, and what a walk of everything
      // reachable would copy in while a walk of own properties would not.
      enumerable: true,
    })
    try {
      const out = ownFields({ real: 'from the caller', nested: {} }) as Record<string, unknown>
      expect(Object.keys(out)).toEqual(['real', 'nested'])
      expect(Object.hasOwn(out, 'planted')).toBe(false)
      expect(Object.keys(out.nested as object)).toEqual([])
      expect(Object.hasOwn(out.nested as object, 'planted')).toBe(false)
      // And nothing answers for a key nobody wrote, at either level.
      expect((out as { planted?: unknown }).planted).toBeUndefined()
      expect((out.nested as { planted?: unknown }).planted).toBeUndefined()
    } finally {
      // biome-ignore lint/performance/noDelete: the planted property has to go, not be set to undefined
      delete (Object.prototype as unknown as Record<string, unknown>).planted
    }
  })
})

describe('what the caller wrote', () => {
  it('takes the slug from the body, not from a poisoned prototype', async () => {
    // A property planted on Object.prototype answers for every plain object
    // that has none of its own, which is how "the caller did not name a slug"
    // turns into "the caller named this one". Non-enumerable, because that is
    // the shape that survives a spread and a JSON round trip unnoticed.
    //
    // `slug` and not `password`: a pool reads `password` off its own options
    // when it opens a connection, so planting that name would test the
    // database driver rather than this route. The two fields are read the same
    // way, by the same helper.
    //
    // Not enumerable here: the listing rows below carry that half. A schema
    // marked strict decides its unrecognised keys with `for…in`, which walks
    // the prototype, so an enumerable plant of any name is refused by the
    // validator before it reaches the value this test is about — a refusal,
    // and the wrong one to be pinning here.
    Object.defineProperty(Object.prototype, 'slug', {
      value: 'planted',
      configurable: true,
      writable: true,
    })
    try {
      const r = await create({ targets: [target] })
      expect(r.statusCode).toBe(201)
      // Both, and the row below: `planted` is itself seven characters a
      // generated slug could be, so the pattern alone accepts the attack.
      expect(r.json().slug).not.toBe('planted')
      expect(r.json().slug).toMatch(/^[A-Za-z0-9]{7}$/)
    } finally {
      // biome-ignore lint/performance/noDelete: the planted property has to go, not be set to undefined
      delete (Object.prototype as unknown as Record<string, unknown>).slug
    }
    const stored = await pg.query<{ slug: string }>('SELECT slug FROM links')
    expect(stored.rows[0]?.slug).not.toBe('planted')
  })

  // The patch route reads the same two fields off its own body, so it strips
  // the prototype off its own body too. One row per body, so removing either
  // fails its own row.
  it('takes the patched fields from the body, not from a poisoned prototype', async () => {
    const created = (await create({ slug: 'keeps-its-slug', targets: [target] })).json()
    Object.defineProperty(Object.prototype, 'slug', {
      value: 'planted',
      configurable: true,
      writable: true,
    })
    try {
      const r = await app.inject({
        method: 'PATCH',
        url: `/api/links/${created.id}`,
        headers: write(cookie),
        payload: { name: 'Renamed' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json().slug).toBe('keeps-its-slug')
    } finally {
      // biome-ignore lint/performance/noDelete: the planted property has to go, not be set to undefined
      delete (Object.prototype as unknown as Record<string, unknown>).slug
    }
    const stored = await pg.query<{ slug: string }>('SELECT slug FROM links')
    expect(stored.rows[0]?.slug).toBe('keeps-its-slug')
  })

  /**
   * The sharper half. A destination is where somebody's traffic goes, and it
   * sits one level down — inside a target, inside `deviceUrls` — where a copy
   * of the body's own top-level fields does not reach. Each row asserts the
   * stored row rather than the response: a planted value that happens to look
   * like a real one passes a response check, and the database is what says
   * what the redirect will actually serve.
   */
  describe('a value one level down', () => {
    const plant = (key: string, value: unknown): void => {
      Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
    }
    const unplant = (key: string): void => {
      delete (Object.prototype as unknown as Record<string, unknown>)[key]
    }

    it('is not taken from the prototype for a target with no url', async () => {
      plant('url', 'https://example.com/planted')
      try {
        // A target object of the caller's own with nothing in it but a weight:
        // the destination would be the planted one, and `core` would validate
        // it as though it had been sent.
        const r = await create({ slug: 'no-url', targets: [{ weight: 100 }] })
        expect(r.statusCode).toBe(400)
        // This module's own bound refuses it first: a target needs a url, and
        // with the prototype gone there is none.
        expect(r.json().error).toBe('invalid_body')
      } finally {
        unplant('url')
      }
      expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
      expect((await pg.query('SELECT 1 FROM link_targets')).rowCount).toBe(0)
    })

    it('is not taken from the prototype for a patched target with no url', async () => {
      const created = (await create({ slug: 'keeps-its-target', targets: [target] })).json()
      plant('url', 'https://example.com/planted')
      try {
        const r = await app.inject({
          method: 'PATCH',
          url: `/api/links/${created.id}`,
          headers: write(cookie),
          payload: { targets: [{ weight: 100 }] },
        })
        expect(r.statusCode).toBe(400)
        expect(r.json().error).toBe('invalid_body')
      } finally {
        unplant('url')
      }
      const stored = await pg.query<{ url: string }>('SELECT url FROM link_targets')
      expect(stored.rows.map((t) => t.url)).toEqual([target.url])
    })

    it('is not taken from the prototype for a device URL nobody set', async () => {
      plant('ios', 'https://example.com/planted')
      try {
        const r = await create({ slug: 'no-device', targets: [target], deviceUrls: {} })
        expect(r.statusCode).toBe(201)
      } finally {
        unplant('ios')
      }
      const stored = await pg.query<{ device_urls: Record<string, string> }>(
        'SELECT device_urls FROM links',
      )
      expect(stored.rows[0]?.device_urls).toEqual({})
    })

    it('is not taken from the prototype for a device URL a patch never mentions', async () => {
      // Half of what a patch validates comes from the stored row, and that
      // half is read the same way: an empty `device_urls` column with an `ios`
      // on the prototype is a platform sent somewhere nobody chose.
      const created = (
        await create({ slug: 'no-device', targets: [target], deviceUrls: {} })
      ).json()
      plant('ios', 'https://example.com/planted')
      try {
        const r = await app.inject({
          method: 'PATCH',
          url: `/api/links/${created.id}`,
          headers: write(cookie),
          payload: { name: 'Renamed' },
        })
        expect(r.statusCode).toBe(200)
      } finally {
        unplant('ios')
      }
      const stored = await pg.query<{ device_urls: Record<string, string> }>(
        'SELECT device_urls FROM links',
      )
      expect(stored.rows[0]?.device_urls).toEqual({})
    })

    it('refuses a body nested deeper than the rebuild goes', async () => {
      // The rebuild walks the body, so how deep it may go is bounded, and the
      // bound answers 400 rather than unwinding the stack into a 500.
      let deep: unknown = 'https://example.com/'
      for (let i = 0; i < 20; i++) deep = [deep]
      const r = await create({ targets: deep })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('invalid_body')
      // The message, not only the code: a body this shape is refused by the
      // field schema too, with the same code, so the code alone would pass
      // whether the bound existed or not.
      expect(r.json().message).toBe('the body is nested too deeply')
      expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
    })
  })

  /**
   * The listing reads two optional fields off what zod returned, and an
   * optional field the caller left out is exactly the read a prototype
   * answers. One row per field.
   */
  describe('a listing filter nobody asked for', () => {
    it('lists the links when a domain is planted', async () => {
      await create({ slug: 'listed', targets: [target] })
      Object.defineProperty(Object.prototype, 'domain', {
        value: 'nowhere.example.test',
        configurable: true,
        writable: true,
      })
      try {
        const r = await app.inject({ method: 'GET', url: '/api/links', headers: read(cookie) })
        expect(r.statusCode).toBe(200)
        expect(r.json().links.map((l: { slug: string }) => l.slug)).toEqual(['listed'])
      } finally {
        // biome-ignore lint/performance/noDelete: the planted property has to go, not be set to undefined
        delete (Object.prototype as unknown as Record<string, unknown>).domain
      }
    })

    it('lists the links when a cursor is planted', async () => {
      await create({ slug: 'listed', targets: [target] })
      Object.defineProperty(Object.prototype, 'cursor', {
        value: 'not-a-uuid',
        configurable: true,
        writable: true,
      })
      try {
        const r = await app.inject({ method: 'GET', url: '/api/links', headers: read(cookie) })
        expect(r.statusCode).toBe(200)
        expect(r.json().links.map((l: { slug: string }) => l.slug)).toEqual(['listed'])
      } finally {
        // biome-ignore lint/performance/noDelete: the planted property has to go, not be set to undefined
        delete (Object.prototype as unknown as Record<string, unknown>).cursor
      }
    })
  })
})

describe('the client a handler holds', () => {
  it('reads the new link back through it, so a pool of one still answers', async () => {
    // One client, and a bounded wait for it. Both halves matter: with one
    // client, a handler that asks the pool for a second while holding the
    // first can never be given one; with the wait bounded, that shows up as a
    // failed request in a known time instead of a hang that only the suite's
    // own timeout ends. The bound is what makes this deterministic.
    const tight = createPgPool(TEST_PG_URL, { max: 1, connectTimeoutMs: 1000 })
    const tightApp = testApp(tight, clock)
    try {
      const r = await tightApp.inject({
        method: 'POST',
        url: '/api/links',
        headers: write(cookie),
        payload: { host: 'go.example.test', slug: 'tight', targets: [target] },
      })
      expect(r.statusCode).toBe(201)
      expect(r.json().slug).toBe('tight')
      // And it went back afterwards: the next request gets the same one.
      const after = await tightApp.inject({
        method: 'GET',
        url: '/api/links',
        headers: read(cookie),
      })
      expect(after.statusCode).toBe(200)
      expect(after.json().links.map((l: { slug: string }) => l.slug)).toEqual(['tight'])
    } finally {
      await tightApp.close()
      await tight.end()
    }
  })

  // Every way out of the write's transaction, not only the one that commits.
  // A client released while its transaction is still open goes back into the
  // pool that way, and the next request to borrow it runs inside a transaction
  // it did not open and will not commit. One client, so "the next request" is
  // certain to be the same connection; the state is read from the other pool,
  // because asking the connection itself would be another statement in the
  // transaction under test.
  interface InTransaction {
    what: string
    status: number
    /** The refusal to make, given the app on the single client and a link to patch. */
    send: (a: FastifyInstance, otherId: string) => Promise<LightMyRequestResponse>
  }

  const refusals: InTransaction[] = [
    {
      what: 'refuses an unknown domain',
      status: 404,
      send: (a) =>
        a.inject({
          method: 'POST',
          url: '/api/links',
          headers: write(cookie),
          payload: { host: 'nowhere.example.test', targets: [target] },
        }),
    },
    {
      what: 'refuses a slug a create asked for',
      status: 409,
      send: (a) =>
        a.inject({
          method: 'POST',
          url: '/api/links',
          headers: write(cookie),
          payload: { host: 'go.example.test', slug: 'taken', targets: [target] },
        }),
    },
    {
      // The patch's conflict is the one refusal Postgres raises rather than
      // this code deciding it: the transaction is already aborted when the
      // 409 is chosen, and it still has to be ended before the client goes
      // back.
      what: 'refuses a slug a patch moved onto',
      status: 409,
      send: (a, otherId) =>
        a.inject({
          method: 'PATCH',
          url: `/api/links/${otherId}`,
          headers: write(cookie),
          payload: { slug: 'taken' },
        }),
    },
  ]

  it.each(refusals)(
    'gives the client back with no transaction open when it $what',
    async ({ send, status }) => {
      const tight = createPgPool(TEST_PG_URL, { max: 1, connectTimeoutMs: 1000 })
      const tightApp = testApp(tight, clock)
      try {
        expect((await create({ slug: 'taken', targets: [target] })).statusCode).toBe(201)
        const other = (await create({ slug: 'other', targets: [target] })).json()
        const pid = (await tight.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid
        const r = await send(tightApp, other.id)
        expect(r.statusCode).toBe(status)
        const state = await pg.query<{ state: string }>(
          'SELECT state FROM pg_stat_activity WHERE pid = $1',
          [pid],
        )
        expect(state.rows[0]?.state).toBe('idle')
        // And the refusal left both links as they were.
        const slugs = await pg.query<{ slug: string }>('SELECT slug FROM links ORDER BY slug')
        expect(slugs.rows.map((l) => l.slug)).toEqual(['other', 'taken'])
      } finally {
        await tightApp.close()
        await tight.end()
      }
    },
  )
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
