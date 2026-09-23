import { DEFAULT_TRAFFIC_SETTINGS } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  await pg.query('TRUNCATE settings')
  await pg.query('INSERT INTO settings DEFAULT VALUES')
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

const get = () => app.inject({ method: 'GET', url: '/api/settings', headers: read(cookie) })
const put = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: write(cookie), payload })

const ALL_FLAG = { bot: 'flag', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' }

// As on the domain routes: the host guard and the cross-site check are not
// credentials, and the hook that resolves one refuses nothing. One row per
// route, so removing one handler's call fails that row alone.
describe('every route needs a credential', () => {
  it.each([
    ['GET', undefined],
    ['PUT', { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 60 }],
  ])('refuses an anonymous %s /api/settings', async (method, payload) => {
    const r = await app.inject({
      method: method as 'GET',
      url: '/api/settings',
      headers: write(),
      ...(payload ? { payload } : {}),
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
  })
})

describe('reading the settings', () => {
  it('reports what the redirect serves', async () => {
    const r = await get()
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ...DEFAULT_TRAFFIC_SETTINGS, problem: null })
  })

  it('reports the defaults, and says why, when the row was deleted by hand', async () => {
    await pg.query('DELETE FROM settings')
    const r = await get()
    expect(r.json().abuserThreshold).toBe(DEFAULT_TRAFFIC_SETTINGS.abuserThreshold)
    expect(r.json().problem).toContain('no settings are stored')
  })

  // The column checks are looser than core in places, so what is stored is
  // read through core's schema rather than trusted — exactly as the redirect
  // reads it.
  it('reports the defaults, and says why, when the stored row is invalid', async () => {
    // Printable ASCII and an http scheme, so the column takes it; a token in
    // the host, so core does not. That gap is why what is read is validated.
    await pg.query("UPDATE settings SET safe_url = 'https://{param:h}/safe'")
    const r = await get()
    // The field the fixture corrupted, not one the defaults happen to match
    // anyway: `safeUrl` is what tells a stored row from the defaults here.
    expect(r.json().safeUrl).toBe(DEFAULT_TRAFFIC_SETTINGS.safeUrl)
    expect(r.json().actions).toEqual(DEFAULT_TRAFFIC_SETTINGS.actions)
    expect(r.json().problem).toContain('invalid')
  })
})

describe('writing the settings', () => {
  it('takes the whole object and stores it', async () => {
    const r = await put({
      actions: { ...ALL_FLAG, bot: 'block' },
      safeUrl: 'https://example.com/safe',
      abuserThreshold: 120,
    })
    expect(r.statusCode).toBe(200)
    const stored = await pg.query<{
      traffic_actions: unknown
      safe_url: string
      abuser_threshold: number
    }>('SELECT traffic_actions, safe_url, abuser_threshold FROM settings')
    expect(stored.rows[0]).toEqual({
      traffic_actions: { ...ALL_FLAG, bot: 'block' },
      safe_url: 'https://example.com/safe',
      abuser_threshold: 120,
    })
  })

  // The row can be deleted. A write that assumed it exists would write
  // nothing and report success.
  it('writes the row back when it is missing', async () => {
    await pg.query('DELETE FROM settings')
    const r = await put({ actions: ALL_FLAG, safeUrl: null, abuserThreshold: 90 })
    expect(r.statusCode).toBe(200)
    const stored = await pg.query<{ abuser_threshold: number }>(
      'SELECT abuser_threshold FROM settings',
    )
    expect(stored.rows[0]?.abuser_threshold).toBe(90)
    expect((await get()).json().problem).toBeNull()
  })

  it.each([
    [
      'the safe action with no safe URL',
      { actions: { ...ALL_FLAG, bot: 'safe' }, safeUrl: null, abuserThreshold: 60 },
    ],
    [
      'an action nobody knows',
      { actions: { ...ALL_FLAG, bot: 'drop' }, safeUrl: null, abuserThreshold: 60 },
    ],
    [
      'a class nobody knows',
      { actions: { ...ALL_FLAG, human: 'flag' }, safeUrl: null, abuserThreshold: 60 },
    ],
    ['a missing class', { actions: { bot: 'flag' }, safeUrl: null, abuserThreshold: 60 }],
    [
      'a safe URL that is not a destination',
      { actions: ALL_FLAG, safeUrl: 'javascript:alert(1)', abuserThreshold: 60 },
    ],
    ['a threshold of zero', { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 0 }],
    ['a threshold past the bound', { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 100_001 }],
    ['a partial write', { abuserThreshold: 90 }],
    // There is one admin, so nothing in a body may name whose settings these
    // are. A strict schema is what makes that checkable rather than ignored.
    [
      'a field it does not know',
      { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 60, accountId: 'a2f' },
    ],
  ])('refuses %s', async (_label, payload) => {
    const before = await get()
    const r = await put(payload)
    expect(r.statusCode).toBe(400)
    expect((await get()).json()).toEqual(before.json())
  })
})
