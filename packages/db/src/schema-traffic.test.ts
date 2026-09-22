import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabases, testCh, testPg } from './testing.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

beforeEach(async () => {
  await pool.query('TRUNCATE settings')
  await pool.query('INSERT INTO settings DEFAULT VALUES')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

const ALL_FLAG = { bot: 'flag', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' }
const setActions = (actions: unknown, safeUrl: string | null = null) =>
  pool.query('UPDATE settings SET traffic_actions = $1, safe_url = $2', [
    JSON.stringify(actions),
    safeUrl,
  ])

describe('postgres schema 004: settings', () => {
  it('holds one row of defaults: flag every class, no safe URL, 60 a minute', async () => {
    const r = await pool.query('SELECT traffic_actions, safe_url, abuser_threshold FROM settings')
    expect(r.rows).toEqual([{ traffic_actions: ALL_FLAG, safe_url: null, abuser_threshold: 60 }])
  })

  it('refuses a second row', async () => {
    await expect(pool.query('INSERT INTO settings DEFAULT VALUES')).rejects.toThrow()
    await expect(pool.query('INSERT INTO settings (id) VALUES (false)')).rejects.toThrow()
  })

  it.each([
    ['an unknown action', { ...ALL_FLAG, bot: 'drop' }],
    ['an unknown class', { ...ALL_FLAG, human: 'flag' }],
    ['a missing class', { bot: 'flag', abuser: 'flag', anonymous: 'flag' }],
    ['an action that is not a string', { ...ALL_FLAG, bot: 1 }],
    ['an array', ['flag']],
  ])('refuses %s', async (_label, actions) => {
    await expect(setActions(actions)).rejects.toThrow()
  })

  it('refuses the safe action without a safe URL, and takes it with one', async () => {
    await expect(setActions({ ...ALL_FLAG, datacenter: 'safe' })).rejects.toThrow(
      /settings_safe_needs_url/,
    )
    await setActions({ ...ALL_FLAG, datacenter: 'safe' }, 'https://example.com/safe')
    await expect(pool.query('UPDATE settings SET safe_url = NULL')).rejects.toThrow(
      /settings_safe_needs_url/,
    )
  })

  it('bounds the abuser threshold', async () => {
    await expect(pool.query('UPDATE settings SET abuser_threshold = 0')).rejects.toThrow()
    await expect(pool.query('UPDATE settings SET abuser_threshold = 100001')).rejects.toThrow()
    await pool.query('UPDATE settings SET abuser_threshold = 100000')
  })
})

describe('postgres schema 004: link overrides', () => {
  const link = async (actions?: unknown) => {
    const d = await pool.query<{ id: string }>(
      "INSERT INTO domains (host) VALUES ('go-' || gen_random_uuid() || '.example.test') RETURNING id",
    )
    return pool.query<{ traffic_actions: unknown }>(
      actions === undefined
        ? "INSERT INTO links (domain_id, slug) VALUES ($1, 's') RETURNING traffic_actions"
        : "INSERT INTO links (domain_id, slug, traffic_actions) VALUES ($1, 's', $2) RETURNING traffic_actions",
      actions === undefined ? [d.rows[0]?.id] : [d.rows[0]?.id, JSON.stringify(actions)],
    )
  }

  it('defaults to no overrides, and takes any subset of the classes', async () => {
    expect((await link()).rows[0]?.traffic_actions).toEqual({})
    expect((await link({ bot: 'block' })).rows[0]?.traffic_actions).toEqual({ bot: 'block' })
  })

  it('refuses an unknown class or action', async () => {
    await expect(link({ human: 'block' })).rejects.toThrow()
    await expect(link({ bot: 'drop' })).rejects.toThrow()
  })
})
