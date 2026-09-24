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
 * The reader comes in two spellings — on the pool, and on a caller's client
 * under the row's lock — sharing one fallback rule. The locked one exists for
 * the retention pass, whose read has to hold still while it deletes.
 *
 * The redirect is the deliberate exception. It reads these settings inside
 * the snapshot's single REPEATABLE READ READ ONLY transaction, together with
 * the domains and links, so that the configuration it serves is one
 * consistent view; a pool-level helper cannot join that transaction, and
 * splitting the read out of it would be a worse trade than the copy.
 */
import {
  DEFAULT_INSTALL_SETTINGS,
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
   * What this install asked to keep, or null when nobody knows what it asked
   * for: the row is missing, or it cannot be read as retention. **Never the
   * defaults in either case.** Applying a retention default deletes clicks,
   * and it is the only default in this product that does — so a caller that
   * deletes things does nothing while this is null.
   *
   * Null is not `{ rawRetentionDays: null, ipRetentionDays: null }`. That pair
   * is an answer: keep both for ever. This is the absence of one, and the two
   * are one `??` apart, which is why each has a test of its own.
   */
  retention: RetentionSettings | null
  problem: string | null
}

const why = (issues: { path: (string | number)[]; message: string }[]): string =>
  issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

/**
 * What `parseRow` knows and `SettingsRead` does not: why each half was
 * refused, without the sentence built around it. `updateSettings` hands both
 * to a caller that is about to overwrite the bad row, so the caller can say
 * which values it could not read.
 */
interface ParsedRow {
  read: SettingsRead
  trafficIssues: string | null
  retentionIssues: string | null
}

/** Each half validated on its own, so one bad column cannot take the other down. */
function parseRow(row: SettingsRow): ParsedRow {
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
  const trafficIssues = traffic.success ? null : why(traffic.error.issues)
  if (trafficIssues !== null) {
    problems.push(`the stored traffic settings are invalid (${trafficIssues}); the defaults apply`)
  }
  const retentionIssues = retention.success ? null : why(retention.error.issues)
  if (retentionIssues !== null) {
    problems.push(
      `the stored retention is invalid (${retentionIssues}); nothing is deleted until it is corrected`,
    )
  }
  return {
    read: {
      traffic: traffic.success ? traffic.data : DEFAULT_TRAFFIC_SETTINGS,
      retention: retention.success ? retention.data : null,
      // Joined with a separator, not a space: both halves can be invalid at
      // once, and run together the two sentences read as one that says the
      // defaults apply to the retention as well — which is the opposite of
      // what the second one says.
      problem: problems.length === 0 ? null : problems.join('; '),
    },
    trafficIssues,
    retentionIssues,
  }
}

/**
 * What this install is actually running, and anything wrong with the row it
 * came from.
 *
 * The two halves answer a missing row differently, and the difference is the
 * point. **Traffic falls back to its defaults**, because the redirect has to
 * answer the next click with something, and being wrong there means
 * classifying a visitor a little differently. **Retention answers null**,
 * because being wrong there means deleting clicks an operator asked to keep —
 * including an operator who asked to keep them for ever, whose stored row
 * says so and whose deleted row says nothing at all. A default that deletes
 * is not a default.
 */
export async function readSettings(pg: Pool): Promise<SettingsRead> {
  const r = await pg.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings`)
  return fromRow(r.rows[0])
}

/**
 * The same read, on a caller's client and under the row's lock.
 *
 * For a caller that only answers a request, the plain read above is right: the
 * answer is a moment old and the next request reads again. For a caller that
 * **deletes** on what it read, a moment is the whole problem — an operator can
 * set a period to `never`, or delete the row outright, in the window between
 * the read and the delete, and the pass would go on to enforce a period that
 * is no longer stored. There is no transaction that can span both stores, so
 * the lock is the join: this takes the same `FOR UPDATE` on the same row that
 * `updateSettings` takes, so a write and a deleting pass serialise and the
 * pass acts on the row as it stands for as long as it holds the lock.
 *
 * It takes no lock when the row is missing — there is nothing to lock — and
 * that needs none: a missing row answers `retention: null`, and a caller that
 * deletes does nothing at all on that answer.
 *
 * The caller owns the transaction, and owes it a `BEGIN` before this and a
 * `COMMIT` or `ROLLBACK` after: the lock is held to the end of the
 * transaction, and that duration is the point.
 */
export async function readSettingsLocked(client: PoolClient): Promise<SettingsRead> {
  const r = await client.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings FOR UPDATE`)
  return fromRow(r.rows[0])
}

/** One fallback rule, whether the row was read under the lock or not. */
function fromRow(row: SettingsRow | undefined): SettingsRead {
  if (!row) {
    return {
      traffic: DEFAULT_TRAFFIC_SETTINGS,
      retention: null,
      problem:
        'no settings are stored; the traffic defaults apply, and nothing is deleted until the row is written back',
    }
  }
  return parseRow(row).read
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
 * One place this function had to invent the value it started from, because the
 * stored row did not supply one.
 *
 * **This is an invariant, not a list of special cases.** Three times now a
 * surface has had to be taught about one more silent substitution — an
 * unreadable retention half, an unreadable traffic half, and a row that was
 * not there at all, where the reader answers "nothing is being deleted" before
 * the command and "deleted after ninety days" after it. Each was the same
 * thing: **the row that was written is not derived from the row that was
 * read**, and the operator was changing something else at the time. So the
 * rule is stated once, here, and every case reports through it. A fourth case
 * needs no new callback, and a surface that handles this one handles it.
 *
 * `what` says which part was invented rather than read: one half, or the whole
 * row. `why` is empty for a missing row — there is nothing to explain beyond
 * its absence — and carries the schema's issues otherwise.
 */
export type SettingsSubstitution =
  | { what: 'row'; why: '' }
  | { what: 'traffic'; why: string }
  | { what: 'retention'; why: string }

export interface UpdateSettingsHooks {
  /**
   * Called, before the write and inside the transaction, with every
   * substitution this call made — and not called at all when it made none.
   * A caller with nowhere to print them passes no hook and is unchanged.
   */
  onSubstituted?: (subs: SettingsSubstitution[]) => void
}

/**
 * Read, change, validate, write — with the row locked for the whole of it, so
 * two callers changing different fields cannot lose one of the changes.
 *
 * The row is written back as the defaults first when it is missing, in the
 * same transaction, so that concurrent writers still serialise on its lock.
 * Postgres collapses identical notifications on one channel inside a
 * transaction, so that insert and the update after it reach the redirect as
 * one `config_changed` and this costs no extra reload — measured, because the
 * comment here used to charge for one.
 */

export async function updateSettings(
  pg: Pool,
  now: Date,
  change: (current: InstallSettings) => InstallSettings,
  hooks: UpdateSettingsHooks = {},
): Promise<InstallSettings> {
  const client: PoolClient = await pg.connect()
  try {
    await client.query('BEGIN')
    // Whether this inserted tells us the row was not there, which is the third
    // substitution and the one the earlier two callbacks could not express:
    // before this statement the reader answered "nothing is being deleted",
    // and after the write it answers a period. `ON CONFLICT DO NOTHING`
    // reports 1 row when it inserted and 0 when the row already existed.
    const ins = await client.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    const r = await client.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings FOR UPDATE`)
    const row = r.rows[0]
    if (!row) throw new Error('the settings row is missing after writing it')
    const { read, trafficIssues, retentionIssues } = parseRow(row)
    const subs: SettingsSubstitution[] = []
    if ((ins.rowCount ?? 0) > 0) subs.push({ what: 'row', why: '' })
    if (trafficIssues !== null) subs.push({ what: 'traffic', why: trafficIssues })
    if (read.retention === null && retentionIssues !== null) {
      subs.push({ what: 'retention', why: retentionIssues })
    }
    if (subs.length > 0) hooks.onSubstituted?.(subs)
    const current: InstallSettings = {
      // The defaults, when the stored half could not be read — and the hook
      // above is what keeps that from being silent.
      traffic: read.traffic,
      // A row this build cannot read as retention starts from the defaults
      // *for a deliberate write*, which is the one place that is right: the
      // operator is here, changing it, and the alternative is a command that
      // cannot repair the row it is complaining about. The hook above is what
      // keeps it from being silent.
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
