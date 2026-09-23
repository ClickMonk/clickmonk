import { hashToken } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_KEYS_LISTED, MAX_KEY_DAYS } from './keys.js'
import { ADMIN_HOST, clockFrom, read, signedIn, testApp, write } from './testing.js'

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
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

const create = (payload: Record<string, unknown> = { name: 'scripting' }) =>
  app.inject({ method: 'POST', url: '/api/keys', headers: write(cookie), payload })

describe('minting an API key', () => {
  it('shows the key once, and stores only its digest', async () => {
    const r = await create()
    expect(r.statusCode).toBe(201)
    const { id, key } = r.json() as { id: string; key: string }
    expect(key.startsWith(`cmk_${id}_`)).toBe(true)
    const stored = await pg.query<{ secret_hash: string }>('SELECT secret_hash FROM api_keys')
    const secret = key.slice(`cmk_${id}_`.length)
    expect(stored.rows[0]?.secret_hash).toBe(hashToken(secret))

    // And no later read gives it back. The whole field set is pinned, not just
    // the absence of the secret itself: a listing that carried `secret_hash`
    // would pass a "does not contain the secret" check — the digest is not the
    // secret — while handing out the material an offline guess is checked
    // against. So what a listed key may say is exactly these six fields.
    const list = await app.inject({ method: 'GET', url: '/api/keys', headers: read(cookie) })
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.json())).not.toContain(secret)
    expect(JSON.stringify(list.json())).not.toContain(hashToken(secret))
    expect(Object.keys(list.json().keys[0]).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'revokedAt',
    ])
    expect(list.json().keys[0]).toMatchObject({ id, name: 'scripting', revokedAt: null })
  })

  it('takes a life in days, bounded', async () => {
    const r = await create({ name: 'temporary', expiresDays: 7 })
    expect(r.statusCode).toBe(201)
    expect(r.json().expiresAt).toBe(new Date('2026-09-30T10:00:00.000Z').toISOString())
    expect((await create({ name: 'forever', expiresDays: MAX_KEY_DAYS + 1 })).statusCode).toBe(400)
    expect((await create({ name: 'never', expiresDays: 0 })).statusCode).toBe(400)
  })

  it('refuses a name that is empty or too long, and an unknown field', async () => {
    expect((await create({ name: '' })).statusCode).toBe(400)
    expect((await create({ name: 'x'.repeat(101) })).statusCode).toBe(400)
    expect((await create({ name: 'x', scopes: ['*'] })).statusCode).toBe(400)
  })

  // The cap stays and paging waits for the UI, so the one thing that must not
  // happen is a caller being handed a prefix and told nothing. Rows are
  // inserted straight in: minting 201 keys would be 201 digests for nothing.
  it('says when the listing was cut', async () => {
    const list = () => app.inject({ method: 'GET', url: '/api/keys', headers: read(cookie) })
    await create()
    expect((await list()).json().truncated).toBe(false)
    await pg.query(
      `INSERT INTO api_keys (id, name, secret_hash)
       SELECT lpad(to_hex(n), 16, '0'), 'bulk-' || n, repeat('b', 64)
         FROM generate_series(1, $1) AS n`,
      [MAX_KEYS_LISTED],
    )
    const cut = await list()
    expect(cut.json().keys).toHaveLength(MAX_KEYS_LISTED)
    expect(cut.json().truncated).toBe(true)
  })
})

describe('revoking one', () => {
  it('stops it working, and says so in the list', async () => {
    const key = (await create()).json() as { id: string; key: string }
    // `/api/me` rather than a write: this test is about the key dying, and it
    // is the one route every credential may read.
    const useIt = () =>
      app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { host: ADMIN_HOST, authorization: `Bearer ${key.key}` },
      })
    expect((await useIt()).statusCode).toBe(200)
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${key.id}`,
      headers: write(cookie),
    })
    expect(revoke.statusCode).toBe(200)
    expect((await useIt()).statusCode).toBe(401)
    const list = await app.inject({ method: 'GET', url: '/api/keys', headers: read(cookie) })
    expect(list.json().keys[0].revokedAt).not.toBeNull()
  })

  // The same rule the other credential routes carry, on the two that are
  // added here: a stolen key must not be able to list the keys or mint a
  // successor that outlives its own revocation.
  it.each([
    ['GET', '/api/keys'],
    ['POST', '/api/keys'],
  ])('cannot be reached by an API key: %s %s', async (method, url) => {
    const minted = (await create({ name: 'scripting' })).json() as { key: string }
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers: { host: ADMIN_HOST, authorization: `Bearer ${minted.key}` },
      payload: method === 'GET' ? undefined : { name: 'a successor' },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('session_required')
    expect((await pg.query('SELECT 1 FROM api_keys')).rowCount).toBe(1)
  })

  it('answers 404 for a key that is not there, or already revoked', async () => {
    const key = (await create()).json() as { id: string }
    const del = () =>
      app.inject({ method: 'DELETE', url: `/api/keys/${key.id}`, headers: write(cookie) })
    expect((await del()).statusCode).toBe(200)
    expect((await del()).statusCode).toBe(404)
    const bad = await app.inject({
      method: 'DELETE',
      url: '/api/keys/not-an-id',
      headers: write(cookie),
    })
    expect(bad.statusCode).toBe(404)
  })
})
