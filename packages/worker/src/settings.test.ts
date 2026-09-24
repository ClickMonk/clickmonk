import { DEFAULT_INSTALL_SETTINGS, DEFAULT_TRAFFIC_SETTINGS } from '@clickmonk/core'
import { type Pool, createPgPool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type SettingsSubstitution,
  readSettings,
  updateSettings,
  writeSettings,
} from './settings.js'

/**
 * Every connection this file's pool opens reports this name to Postgres, so
 * that the leaked-transaction probe below can ask about *these* connections
 * and no others. Set on the connection string, because that is the only place
 * it reaches every connection the pool opens, including ones it opens later.
 */
const APP_NAME = 'clickmonk-worker-settings-test'
const pool: Pool = createPgPool(`${TEST_PG_URL}?application_name=${APP_NAME}`)
const ch = testCh()
const NOW = new Date('2026-09-24T12:00:00.000Z')

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

describe('readSettings', () => {
  it('reads the stored row as both halves, with nothing to report', async () => {
    expect(await readSettings(pool)).toEqual({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
      problem: null,
    })
  })

  it('reads a row an operator changed', async () => {
    await pool.query('UPDATE settings SET raw_retention_days = 400, ip_retention_days = NULL')
    const r = await readSettings(pool)
    expect(r.retention).toEqual({ rawRetentionDays: 400, ipRetentionDays: null })
    expect(r.problem).toBeNull()
  })

  /**
   * A missing row and an unreadable one are the same answer, and it is not the
   * defaults. The pass that deletes clicks reads `retention`, so a row deleted
   * by hand answering `{90, 30}` would delete every click older than ninety
   * days on an install whose operator had set "never" — the row that said so
   * being exactly the row that is gone. Traffic still falls back, because the
   * redirect has to answer the next click with something.
   */
  it('answers null retention, not the defaults, when there is no row at all', async () => {
    await pool.query('TRUNCATE settings')
    expect(await readSettings(pool)).toEqual({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: null,
      problem:
        'no settings are stored; the traffic defaults apply, and nothing is deleted until the row is written back',
    })
  })

  /**
   * The other side of that null, and one `??` away from it: a stored pair of
   * nulls is an answer — keep both for ever — and must never read as "nobody
   * knows". Collapsing the two is how "never delete" becomes "delete on the
   * defaults".
   */
  it('answers a stored pair of nulls as for ever, which is not the absence of an answer', async () => {
    await pool.query('UPDATE settings SET raw_retention_days = NULL, ip_retention_days = NULL')
    expect(await readSettings(pool)).toEqual({
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: { rawRetentionDays: null, ipRetentionDays: null },
      problem: null,
    })
  })

  /**
   * The rule this module exists to hold. A default is a safe answer when the
   * thing it stands in for is an action — flag rather than block. A retention
   * default is not: applying it deletes clicks. So a row this build cannot
   * read as retention answers null, and the pass that reads it does nothing.
   */
  it('answers null for retention it cannot read, rather than the defaults', async () => {
    // Past the column CHECK, which is what hand-written SQL that dropped the
    // constraint would leave behind. Written by dropping it here, because the
    // constraint is doing its job and this is the case where it is not there.
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_raw_retention_valid')
    try {
      await pool.query('UPDATE settings SET raw_retention_days = -5')
      const r = await readSettings(pool)
      expect(r.retention).toBeNull()
      expect(r.problem).toBe(
        'the stored retention is invalid (rawRetentionDays: Number must be greater than or equal to 1); nothing is deleted until it is corrected',
      )
      // The other half still reads, because one bad column must not take the
      // traffic settings down with it.
      expect(r.traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS)
    } finally {
      // In a `finally`, because a failing assertion here would otherwise leave
      // this file's database without the constraint for every test after it,
      // and `resetDatabases` only runs in `beforeAll`. The row is put back
      // first: a constraint added over a row that still breaks it is refused,
      // and then nothing after this point has it.
      await pool.query('UPDATE settings SET raw_retention_days = 90')
      await pool.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_raw_retention_valid CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650)',
      )
    }
  })

  it('falls back to the default traffic settings without touching retention', async () => {
    // Retention is moved off its defaults first, so that the assertion below
    // is about the retention half surviving rather than about the defaults
    // happening to match: a build that answered the defaults for both halves
    // whenever either failed would agree with an unchanged fixture.
    await pool.query('UPDATE settings SET raw_retention_days = 400, ip_retention_days = NULL')
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_traffic_actions_check')
    try {
      await pool.query(`UPDATE settings SET traffic_actions = '{"bot":"drop"}'::jsonb`)
      const r = await readSettings(pool)
      expect(r.traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS)
      expect(r.retention).toEqual({ rawRetentionDays: 400, ipRetentionDays: null })
      expect(r.problem).toMatch(/^the stored traffic settings are invalid \(/)
    } finally {
      await pool.query(
        `UPDATE settings SET traffic_actions =
           '{"bot":"flag","abuser":"flag","anonymous":"flag","datacenter":"flag"}'::jsonb`,
      )
      await pool.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_traffic_actions_check CHECK (valid_traffic_actions(traffic_actions, true))',
      )
    }
  })

  // Both halves at once, which nothing else covers and which is where the two
  // sentences meet. Run together they read as one saying the defaults apply to
  // the retention as well, which is the opposite of what the second one says.
  it('reports both halves separately when neither can be read', async () => {
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_traffic_actions_check')
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_raw_retention_valid')
    try {
      await pool.query(
        `UPDATE settings SET traffic_actions = '{"bot":"drop"}'::jsonb, raw_retention_days = -5`,
      )
      const r = await readSettings(pool)
      expect(r.traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS)
      expect(r.retention).toBeNull()
      // Exact, and the separator between the two halves is the point: without
      // one, "…the defaults apply" runs straight into "the stored retention is
      // invalid…".
      expect(r.problem).toBe(
        `the stored traffic settings are invalid (actions.bot: Invalid enum value. Expected 'nothing' | 'flag' | 'block' | 'safe', received 'drop'; actions.abuser: Required; actions.anonymous: Required; actions.datacenter: Required); the defaults apply; the stored retention is invalid (rawRetentionDays: Number must be greater than or equal to 1); nothing is deleted until it is corrected`,
      )
    } finally {
      await pool.query(
        `UPDATE settings SET raw_retention_days = 90, traffic_actions =
           '{"bot":"flag","abuser":"flag","anonymous":"flag","datacenter":"flag"}'::jsonb`,
      )
      await pool.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_traffic_actions_check CHECK (valid_traffic_actions(traffic_actions, true))',
      )
      await pool.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_raw_retention_valid CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650)',
      )
    }
  })
})

describe('writeSettings', () => {
  it('writes both halves in one statement, and writes the row back when it is gone', async () => {
    await pool.query('TRUNCATE settings')
    await writeSettings(
      pool,
      {
        traffic: { ...DEFAULT_TRAFFIC_SETTINGS, abuserThreshold: 120 },
        retention: { rawRetentionDays: 7, ipRetentionDays: null },
      },
      NOW,
    )
    const r = await readSettings(pool)
    expect(r.traffic.abuserThreshold).toBe(120)
    expect(r.retention).toEqual({ rawRetentionDays: 7, ipRetentionDays: null })
    const rows = await pool.query(
      'SELECT count(*)::int AS n, updated_at FROM settings GROUP BY updated_at',
    )
    expect(rows.rows).toEqual([{ n: 1, updated_at: NOW }])
  })
})

describe('updateSettings', () => {
  it('changes only what the caller changed', async () => {
    const next = await updateSettings(pool, NOW, (current) => ({
      ...current,
      retention: { ...current.retention, ipRetentionDays: 1 },
    }))
    expect(next.retention).toEqual({ rawRetentionDays: 90, ipRetentionDays: 1 })
    expect(next.traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS)
    expect((await readSettings(pool)).retention).toEqual({
      rawRetentionDays: 90,
      ipRetentionDays: 1,
    })
  })

  it('refuses a change that does not validate, and writes nothing', async () => {
    // A safe URL with a token in its host first: the column CHECK takes it
    // (printable ASCII, an http scheme) and core does not, so it is a change
    // only the schema in front of the write can refuse. A period of 0 alone
    // would not pin that schema at all — the column refuses it as well, so a
    // build that had stopped validating would still be rejected, by Postgres.
    await expect(
      updateSettings(pool, NOW, (current) => ({
        ...current,
        traffic: { ...current.traffic, safeUrl: 'https://{param:h}/safe' },
      })),
    ).rejects.toThrow()
    expect((await readSettings(pool)).traffic.safeUrl).toBeNull()
    await expect(
      updateSettings(pool, NOW, (current) => ({
        ...current,
        retention: { ...current.retention, rawRetentionDays: 0 },
      })),
    ).rejects.toThrow()
    expect((await readSettings(pool)).retention).toEqual({
      rawRetentionDays: 90,
      ipRetentionDays: 30,
    })
    // And the client went back to the pool with nothing open. Re-reading the
    // row is not enough on its own: the next read is usually served by the
    // very connection that leaked, which sees its own uncommitted work and
    // answers as if the rollback had happened. A second connection is what
    // can see a backend left sitting inside a transaction.
    //
    // Scoped to this file's own connections by `application_name`, which is
    // what makes it exact rather than dependent on nothing else running: the
    // pool above tags every connection it opens, this probe opens its own
    // untagged one, and a suite in another process cannot be counted here.
    const probe = testPg()
    try {
      const open = await probe.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1
            AND state LIKE 'idle in transaction%'`,
        [APP_NAME],
      )
      expect(open.rows[0]?.n).toBe(0)
    } finally {
      await probe.end()
    }
  })

  it('starts from the defaults when the row was deleted by hand', async () => {
    await pool.query('TRUNCATE settings')
    const next = await updateSettings(pool, NOW, (current) => ({
      ...current,
      retention: { ...current.retention, rawRetentionDays: 5 },
    }))
    expect(next).toEqual({
      traffic: DEFAULT_INSTALL_SETTINGS.traffic,
      retention: { rawRetentionDays: 5, ipRetentionDays: 30 },
    })
  })

  /**
   * The third substitution, and the one two separate callbacks could not
   * express. Before this call the reader answers `retention: null` and a pass
   * deletes nothing; after it the row says ninety days and the pass deletes by
   * it. Nothing in the command asked for that, so it is reported.
   */
  it('reports writing a row that was not there', async () => {
    await pool.query('TRUNCATE settings')
    const subs: SettingsSubstitution[][] = []
    await updateSettings(
      pool,
      NOW,
      (current) => ({
        ...current,
        traffic: { ...current.traffic, abuserThreshold: 61 },
      }),
      { onSubstituted: (s) => subs.push(s) },
    )
    expect(subs).toEqual([[{ what: 'row', why: '' }]])
  })

  // The report is of a substitution, not of a write: a command that started
  // from the row it found substituted nothing, and a hook called every time
  // would be a banner rather than a warning.
  it('reports nothing when it started from the row it read', async () => {
    const subs: SettingsSubstitution[][] = []
    await updateSettings(
      pool,
      NOW,
      (current) => ({
        ...current,
        traffic: { ...current.traffic, abuserThreshold: 61 },
      }),
      { onSubstituted: (s) => subs.push(s) },
    )
    expect(subs).toEqual([])
  })
})
