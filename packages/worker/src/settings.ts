/**
 * The install's settings row: one reader, one writer, one merge.
 *
 * Three copies of "read the row, fall back to the defaults, say why" existed
 * or were about to — the command line's, the admin API's and the retention
 * pass's — and three copies of a fallback rule is where they begin to
 * disagree about what an install is actually doing. This is the one. It lives
 * in the worker package because that is where the other functions two
 * surfaces share already live.
 *
 * The redirect is the deliberate exception. It reads these settings inside
 * the snapshot's single REPEATABLE READ READ ONLY transaction, together with
 * the domains and links, so that the configuration it serves is one
 * consistent view; a pool-level helper cannot join that transaction, and
 * splitting the read out of it would be a worse trade than the copy.
 */
import {
  DEFAULT_INSTALL_SETTINGS,
  DEFAULT_RETENTION,
  DEFAULT_TRAFFIC_SETTINGS,
  type InstallSettings,
  InstallSettingsSchema,
  type RetentionSettings,
  RetentionSettingsSchema,
  type TrafficActions,
  type TrafficSettings,
  TrafficSettingsSchema,
} from '@clickmonk/core'
import type { Pool, PoolClient } from '@clickmonk/db'

interface SettingsRow {
  traffic_actions: TrafficActions
  safe_url: string | null
  abuser_threshold: number
  raw_retention_days: number | null
  ip_retention_days: number | null
}

const COLUMNS = 'traffic_actions, safe_url, abuser_threshold, raw_retention_days, ip_retention_days'

export interface SettingsRead {
  traffic: TrafficSettings
  /**
   * Null when the stored row cannot be read as retention at all. Not the
   * defaults: applying a retention default deletes clicks, and it is the only
   * default in this product that does. A caller that deletes things does
   * nothing while this is null.
   */
  retention: RetentionSettings | null
  problem: string | null
}

const why = (issues: { path: (string | number)[]; message: string }[]): string =>
  issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

/** Each half validated on its own, so one bad column cannot take the other down. */
function parseRow(row: SettingsRow): SettingsRead {
  const traffic = TrafficSettingsSchema.safeParse({
    actions: row.traffic_actions,
    safeUrl: row.safe_url,
    abuserThreshold: row.abuser_threshold,
  })
  const retention = RetentionSettingsSchema.safeParse({
    rawRetentionDays: row.raw_retention_days,
    ipRetentionDays: row.ip_retention_days,
  })
  const problems: string[] = []
  if (!traffic.success) {
    problems.push(
      `the stored traffic settings are invalid (${why(traffic.error.issues)}); the defaults apply`,
    )
  }
  if (!retention.success) {
    problems.push(
      `the stored retention is invalid (${why(retention.error.issues)}); nothing is deleted until it is corrected`,
    )
  }
  return {
    traffic: traffic.success ? traffic.data : DEFAULT_TRAFFIC_SETTINGS,
    retention: retention.success ? retention.data : null,
    problem: problems.length === 0 ? null : problems.join(' '),
  }
}

/** What this install is actually running, and anything wrong with the row it came from. */
export async function readSettings(pg: Pool): Promise<SettingsRead> {
  const r = await pg.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings`)
  const row = r.rows[0]
  if (!row) {
    return {
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: DEFAULT_RETENTION,
      problem: 'no settings are stored; the defaults apply',
    }
  }
  return parseRow(row)
}

/**
 * Writes the whole row.
 *
 * One statement, because `settings` fires `config_changed` from a statement
 * trigger: an insert followed by an update would make the redirect reload its
 * whole snapshot twice for one write. It upserts rather than assuming the row
 * is there, because it can be deleted by hand and an UPDATE alone would match
 * nothing and report success.
 */
export async function writeSettings(pg: Pool, next: InstallSettings, now: Date): Promise<void> {
  await pg.query(
    `INSERT INTO settings (id, traffic_actions, safe_url, abuser_threshold,
                           raw_retention_days, ip_retention_days, updated_at)
     VALUES (true, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET traffic_actions = EXCLUDED.traffic_actions, safe_url = EXCLUDED.safe_url,
           abuser_threshold = EXCLUDED.abuser_threshold,
           raw_retention_days = EXCLUDED.raw_retention_days,
           ip_retention_days = EXCLUDED.ip_retention_days,
           updated_at = EXCLUDED.updated_at`,
    [
      JSON.stringify(next.traffic.actions),
      next.traffic.safeUrl,
      next.traffic.abuserThreshold,
      next.retention.rawRetentionDays,
      next.retention.ipRetentionDays,
      now,
    ],
  )
}

/**
 * Read, change, validate, write — with the row locked for the whole of it, so
 * two callers changing different fields cannot lose one of the changes.
 *
 * The row is written back as the defaults first when it is missing, in the
 * same transaction, so that concurrent writers still serialise on its lock.
 * That costs one extra `config_changed` on a command an operator typed, which
 * is cheaper than a read-modify-write with nothing to lock.
 */
export async function updateSettings(
  pg: Pool,
  now: Date,
  change: (current: InstallSettings) => InstallSettings,
): Promise<InstallSettings> {
  const client: PoolClient = await pg.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    const r = await client.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings FOR UPDATE`)
    const row = r.rows[0]
    if (!row) throw new Error('the settings row is missing after writing it')
    const read = parseRow(row)
    const current: InstallSettings = {
      traffic: read.traffic,
      // A row this build cannot read as retention starts from the defaults
      // *for a deliberate write*, which is the one place that is right: the
      // operator is here, changing it, and the alternative is a command that
      // cannot repair the row it is complaining about.
      retention: read.retention ?? DEFAULT_INSTALL_SETTINGS.retention,
    }
    const next = InstallSettingsSchema.parse(change(current))
    await client.query(
      `UPDATE settings SET traffic_actions = $1, safe_url = $2, abuser_threshold = $3,
                           raw_retention_days = $4, ip_retention_days = $5, updated_at = $6`,
      [
        JSON.stringify(next.traffic.actions),
        next.traffic.safeUrl,
        next.traffic.abuserThreshold,
        next.retention.rawRetentionDays,
        next.retention.ipRetentionDays,
        now,
      ],
    )
    await client.query('COMMIT')
    return next
  } catch (err) {
    // Every exit path rolls back before the client goes back to the pool: a
    // client released inside an open transaction is a connection the next
    // caller inherits mid-transaction.
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
