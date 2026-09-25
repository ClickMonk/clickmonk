import { DEFAULT_RETENTION, DEFAULT_TRAFFIC_SETTINGS } from '@clickmonk/core'
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
  cookie = await signedIn(app, pg, clock.now())
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
  // As on the domain routes, the status code is not the guard on its own: a
  // handler that writes and then refuses answers 401 having already changed
  // what the redirect serves every visitor.
  it.each([
    { name: 'GET', method: 'GET' as const, payload: undefined },
    {
      name: 'PUT',
      method: 'PUT' as const,
      payload: {
        traffic: { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 99 },
        retention: DEFAULT_RETENTION,
      },
    },
  ])('refuses an anonymous $name /api/settings, and changes nothing', async (row) => {
    const r = await app.inject({
      method: row.method,
      url: '/api/settings',
      headers: write(),
      ...(row.payload ? { payload: row.payload } : {}),
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
    // The refusal and nothing else: no settings in the body of a refused read.
    expect(Object.keys(r.json()).sort()).toEqual(['error', 'message'])
    const stored = await pg.query<{ abuser_threshold: number }>(
      'SELECT abuser_threshold FROM settings',
    )
    expect(stored.rows[0]?.abuser_threshold).toBe(DEFAULT_TRAFFIC_SETTINGS.abuserThreshold)
  })
})

describe('reading the settings', () => {
  it('reports the retention periods and says nothing when they are the usual way round', async () => {
    const r = await get()
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
      note: null,
      problem: null,
    })
  })

  // The two halves answer a missing row differently on purpose. Traffic falls
  // back, because the redirect has to answer the next click. Retention does
  // not: a number here would be a number the pass deletes by, on an install
  // whose stored period is gone and may have said "never".
  it('reports the traffic defaults but no retention, and says why, when the row was deleted by hand', async () => {
    await pg.query('DELETE FROM settings')
    const r = await get()
    expect(r.json()).toEqual({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: null,
      note: null,
      problem:
        'no settings are stored; the traffic defaults apply, and nothing is deleted until the row is written back',
    })
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
    expect(r.json().traffic.safeUrl).toBe(DEFAULT_TRAFFIC_SETTINGS.safeUrl)
    expect(r.json().traffic.actions).toEqual(DEFAULT_TRAFFIC_SETTINGS.actions)
    expect(r.json().problem).toContain('invalid')
  })

  // A row the retention half cannot be read from is reported as unreadable
  // rather than as the defaults: the pass deletes nothing while it is in that
  // state, and an operator shown "90 days" could not tell the two apart.
  it('reports retention as null, and says why, when it cannot be read', async () => {
    await pg.query('ALTER TABLE settings DROP CONSTRAINT settings_raw_retention_valid')
    try {
      await pg.query('UPDATE settings SET raw_retention_days = -5')
      const r = await get()
      expect(r.json().retention).toBeNull()
      expect(r.json().note).toBeNull()
      expect(r.json().problem).toContain('nothing is deleted until it is corrected')
    } finally {
      await pg.query('UPDATE settings SET raw_retention_days = 90')
      await pg.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_raw_retention_valid CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650)',
      )
    }
  })
})

describe('writing the settings', () => {
  it('takes the whole object and stores it', async () => {
    const r = await put({
      traffic: {
        actions: { ...ALL_FLAG, bot: 'block' },
        safeUrl: 'https://example.com/safe',
        abuserThreshold: 120,
      },
      retention: DEFAULT_RETENTION,
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

  it('writes both halves, and notes an address period that outlives its clicks', async () => {
    const r = await put({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: { rawRetentionDays: 30, ipRetentionDays: 90 },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().note).toBe(
      'addresses are set to be kept for 90 days but clicks for 30 days, so an address goes when its click does, after 30 days',
    )
    const back = await get()
    expect(back.json().retention).toEqual({ rawRetentionDays: 30, ipRetentionDays: 90 })
  })

  // The retention pass holds this row while it deletes, and the writer stops
  // waiting rather than holding this request open for the length of a pass —
  // Fastify's own request timeout does not bound a handler, so waiting here is
  // waiting with a connection of a pool of four. Nothing is wrong with the
  // request, which is why it is 503 with a `retry-after` and not a 4xx.
  it('answers 503 while the settings row is held, and writes nothing', async () => {
    const holder = await pg.connect()
    let r: Awaited<ReturnType<typeof put>>
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM settings FOR UPDATE')
      r = await put({
        traffic: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 120 },
        retention: { rawRetentionDays: 5, ipRetentionDays: 5 },
      })
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
    expect(r.statusCode).toBe(503)
    expect(r.headers['retry-after']).toBe('5')
    expect(r.json()).toEqual({
      error: 'settings_locked',
      message:
        'the settings row is held by another writer, most likely the retention pass, which holds it for the length of one pass; nothing was written, so run this again in a moment',
    })
    const back = await get()
    expect(back.json().traffic.abuserThreshold).toBe(60)
    expect(back.json().retention).toEqual({ rawRetentionDays: 90, ipRetentionDays: 30 })
  })

  it('refuses a body whose retention half is invalid, and writes neither half', async () => {
    const r = await put({
      traffic: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 120 },
      retention: { rawRetentionDays: 0, ipRetentionDays: 30 },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    // The traffic half was valid and is still not written: a settings write is
    // one write, and half of one is how an install ends up in a state nobody
    // asked for.
    const back = await get()
    expect(back.json().traffic.abuserThreshold).toBe(60)
    expect(back.json().retention).toEqual({ rawRetentionDays: 90, ipRetentionDays: 30 })
  })

  it('refuses a settings body with a field nobody knows, and writes nothing', async () => {
    const before = await get()
    const r = await put({
      // A body whose two known halves are *changes*, so that a handler which
      // ignored the unknown field instead of refusing would leave both of them
      // written and the read-back below would catch it. With the halves equal
      // to what is stored, a refusal and a silent acceptance look the same.
      traffic: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 77 },
      retention: { rawRetentionDays: 11, ipRetentionDays: 3 },
      keepEverything: true,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    expect((await get()).json()).toEqual(before.json())
  })

  it('refuses a body that leaves a half out, rather than defaulting it', async () => {
    const r = await put({ traffic: DEFAULT_TRAFFIC_SETTINGS })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
    // Nothing was written: a refusal that had already written the traffic half
    // would leave the row half-changed.
    const back = await get()
    expect(back.json().retention).toEqual({ rawRetentionDays: 90, ipRetentionDays: 30 })
  })

  // The row can be deleted. A write that assumed it exists would write
  // nothing and report success.
  it('writes the row back when it is missing', async () => {
    await pg.query('DELETE FROM settings')
    const r = await put({
      traffic: { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 90 },
      retention: DEFAULT_RETENTION,
    })
    expect(r.statusCode).toBe(200)
    const stored = await pg.query<{ abuser_threshold: number }>(
      'SELECT abuser_threshold FROM settings',
    )
    expect(stored.rows[0]?.abuser_threshold).toBe(90)
    expect((await get()).json().problem).toBeNull()
  })

  // Every row here is a traffic half the inner schema refuses, so each one
  // proves that nesting did not stop the half's own schema from running.
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
    ['a partial traffic half', { abuserThreshold: 90 }],
    // There is one admin, so nothing in a body may name whose settings these
    // are. A strict schema is what makes that checkable rather than ignored.
    [
      'a field it does not know',
      { actions: ALL_FLAG, safeUrl: null, abuserThreshold: 60, accountId: 'a2f' },
    ],
  ])('refuses %s', async (_label, traffic) => {
    const before = await get()
    const r = await put({ traffic, retention: DEFAULT_RETENTION })
    expect(r.statusCode).toBe(400)
    expect((await get()).json()).toEqual(before.json())
  })
})
