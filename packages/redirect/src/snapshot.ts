import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import {
  type CountryRule,
  DEFAULT_TRAFFIC_SETTINGS,
  type Device,
  type Domain,
  type Link,
  type LinkTrafficActions,
  LinkTrafficActionsSchema,
  MAX_PASSWORD_HASH_LENGTH,
  type TrafficSettings,
  TrafficSettingsSchema,
} from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import pg from 'pg'
import { type WriteFn, writeAll } from './write-all.js'

export class SnapshotTooLargeError extends Error {
  constructor(count: number, max: number) {
    super(
      `configuration has ${count} links, over the bound of ${max}; keeping the previous snapshot`,
    )
    this.name = 'SnapshotTooLargeError'
  }
}

/** Everything the redirect needs, in memory. Immutable once built. */
export class Snapshot {
  private readonly byHost: Map<string, Domain>
  private readonly bySlug: Map<string, Link>

  constructor(
    domains: Domain[],
    links: Link[],
    readonly loadedAt: Date,
    readonly source: 'postgres' | 'file',
    /** The install-wide traffic settings; the defaults until Postgres has any. */
    readonly settings: TrafficSettings = DEFAULT_TRAFFIC_SETTINGS,
  ) {
    this.byHost = new Map(domains.map((d) => [d.host, d]))
    this.bySlug = new Map(links.map((l) => [`${l.domainId}/${l.slug}`, l]))
  }

  domain(host: string): Domain | null {
    return this.byHost.get(host) ?? null
  }

  link(domainId: string, slug: string): Link | null {
    return this.bySlug.get(`${domainId}/${slug}`) ?? null
  }

  get size(): { domains: number; links: number } {
    return { domains: this.byHost.size, links: this.bySlug.size }
  }

  /** @internal for serialisation */
  entries(): { domains: Domain[]; links: Link[] } {
    return { domains: [...this.byHost.values()], links: [...this.bySlug.values()] }
  }
}

interface LinkRow {
  id: string
  domain_id: string
  slug: string
  enabled: boolean
  backup_url: string | null
  device_urls: Partial<Record<Device, string>>
  returning_url: string | null
  countries: CountryRule
  click_cap: string | null
  expires_at: Date | null
  passthrough: boolean
  traffic_actions: unknown
  password_hash: string | null
  targets: { id: string; url: string; weight: number }[] | null
}

export interface SettingsRow {
  traffic_actions: unknown
  safe_url: string | null
  abuser_threshold: number
}

type Log = (msg: string, err?: unknown) => void

const issues = (e: { issues: { path: (string | number)[]; message: string }[] }): string =>
  e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')

/**
 * The settings row, read through core's schema rather than trusted: the
 * database checks are looser than core in places (a token in the safe URL's
 * host, say). Missing or refused, the defaults apply and `problem` says why.
 */
export function settingsFromRow(row: SettingsRow | undefined): {
  settings: TrafficSettings
  problem: string | null
} {
  if (!row) return { settings: DEFAULT_TRAFFIC_SETTINGS, problem: 'the settings row is missing' }
  return validSettings(
    { actions: row.traffic_actions, safeUrl: row.safe_url, abuserThreshold: row.abuser_threshold },
    'the settings row',
  )
}

function validSettings(
  value: unknown,
  what: string,
): { settings: TrafficSettings; problem: string | null } {
  const r = TrafficSettingsSchema.safeParse(value)
  return r.success
    ? { settings: r.data, problem: null }
    : { settings: DEFAULT_TRAFFIC_SETTINGS, problem: `${what} is invalid (${issues(r.error)})` }
}

const refusedOverrides = (n: number): string =>
  `traffic action overrides of ${n} link(s) are invalid and ignored`

/** A link's overrides through core's schema. Refused, the link keeps none and `problem` says why. */
export function linkActionsFromRow(raw: unknown): {
  actions: LinkTrafficActions
  problem: string | null
} {
  const r = LinkTrafficActionsSchema.safeParse(raw)
  return r.success ? { actions: r.data, problem: null } : { actions: {}, problem: issues(r.error) }
}

const unreadableHashes = (n: number): string =>
  `password hashes of ${n} link(s) are unreadable; those links stay locked`

/**
 * What a link's password hash becomes when the file's value is not one: no
 * verifier parses it, so the link stays locked and every answer to it is
 * wrong. Falling back to null instead would open a protected link to
 * everyone, which is the one outcome a corrupt or foreign file must not
 * produce.
 */
export const UNREADABLE_PASSWORD_HASH = 'unreadable'

/**
 * A link's password hash out of a snapshot file. Postgres has a CHECK on the
 * column, so only a file — one written by another release, or damaged — can
 * carry something else there. Absent is no password. A string within the
 * bound is taken as it is: whether it parses is the verifier's judgement, and
 * the verifier already treats one it cannot parse as a wrong password.
 * Anything else keeps the link locked rather than losing its password.
 */
export function linkPasswordHashFromFile(raw: unknown): {
  passwordHash: string | null
  problem: string | null
} {
  if (raw === undefined || raw === null) return { passwordHash: null, problem: null }
  if (typeof raw === 'string' && raw.length <= MAX_PASSWORD_HASH_LENGTH) {
    return { passwordHash: raw, problem: null }
  }
  // Never the value itself: whatever was written where a hash belongs is not
  // something to put in a log line.
  return {
    passwordHash: UNREADABLE_PASSWORD_HASH,
    problem: `not a string of at most ${MAX_PASSWORD_HASH_LENGTH} characters`,
  }
}

/**
 * One REPEATABLE READ READ ONLY transaction on one connection, so the count,
 * the settings, the domains and the links are all a consistent view of the
 * same instant.
 * Three queries on separate pool connections could each see a different
 * commit in between (a target inserted after the count, say), producing a
 * snapshot that never existed in Postgres.
 */
export async function loadFromPostgres(
  pool: Pool,
  maxLinks = 2_000_000,
  log: Log = () => {},
): Promise<Snapshot> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM links')
      const n = Number(count.rows[0]?.n ?? 0)
      if (n > maxLinks) throw new SnapshotTooLargeError(n, maxLinks)

      // One row by construction, but it can be deleted by hand.
      const settingsRow = await client.query<SettingsRow>(
        'SELECT traffic_actions, safe_url, abuser_threshold FROM settings',
      )
      const { settings, problem } = settingsFromRow(settingsRow.rows[0])
      if (problem) log(`traffic settings: ${problem}; using the defaults`)

      const domains = await client.query<{
        id: string
        host: string
        verified: boolean
        root_url: string | null
        not_found_url: string | null
      }>('SELECT id, host, verified, root_url, not_found_url FROM domains')

      // Targets aggregated per link in position order. A link with no targets is
      // dropped: the evaluator cannot choose a destination for it.
      const links = await client.query<LinkRow>(`
        SELECT l.id, l.domain_id, l.slug, l.enabled, l.backup_url, l.device_urls, l.returning_url,
               l.countries, l.click_cap, l.expires_at, l.passthrough, l.traffic_actions,
               l.password_hash,
               json_agg(json_build_object('id', t.id, 'url', t.url, 'weight', t.weight)
                        ORDER BY t.position) FILTER (WHERE t.id IS NOT NULL) AS targets
          FROM links l
          LEFT JOIN link_targets t ON t.link_id = l.id
         GROUP BY l.id`)

      await client.query('COMMIT')

      // One line per load however many links are affected.
      let refused = 0
      const actionsOf = (r: LinkRow): LinkTrafficActions => {
        const a = linkActionsFromRow(r.traffic_actions)
        if (a.problem) refused++
        return a.actions
      }

      const snapshot = new Snapshot(
        domains.rows.map((d) => ({
          id: d.id,
          host: d.host,
          verified: d.verified,
          rootUrl: d.root_url,
          notFoundUrl: d.not_found_url,
        })),
        links.rows
          .filter((r) => r.targets !== null && r.targets.length > 0)
          .map((r) => ({
            id: r.id,
            domainId: r.domain_id,
            slug: r.slug,
            enabled: r.enabled,
            targets: r.targets ?? [],
            backupUrl: r.backup_url,
            deviceUrls: r.device_urls,
            returningUrl: r.returning_url,
            countries: r.countries,
            // bigint arrives as a string from pg.
            clickCap: r.click_cap === null ? null : Number(r.click_cap),
            expiresAt: r.expires_at,
            passthrough: r.passthrough,
            // Carried so the gate can verify an answer without a query. It is
            // a hash of a password, not a password, and it never leaves the
            // process except into the snapshot file beside it.
            passwordHash: r.password_hash,
            trafficActions: actionsOf(r),
          })),
        new Date(),
        'postgres',
        settings,
      )
      if (refused > 0) log(refusedOverrides(refused))
      return snapshot
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

export function serializeSnapshot(s: Snapshot): string {
  return JSON.stringify({
    v: 2,
    loadedAt: s.loadedAt.toISOString(),
    settings: s.settings,
    ...s.entries(),
  })
}

/**
 * Reads version 2, and version 1 as written before traffic settings existed:
 * the defaults and no link overrides, which is what Postgres held then too.
 * A redirect upgraded while Postgres is down still serves its last snapshot.
 * A version 2 file's settings and overrides pass core's schemas as they do
 * from Postgres; refused, the defaults and no overrides apply, with a log.
 */
export function deserializeSnapshot(text: string, log: Log = () => {}): Snapshot {
  const raw = JSON.parse(text) as {
    v: number
    loadedAt: string
    settings?: unknown
    domains: Domain[]
    links: (Omit<Link, 'expiresAt' | 'trafficActions' | 'passwordHash'> & {
      expiresAt: string | null
      trafficActions?: unknown
      passwordHash?: unknown
    })[]
  }
  if (raw.v !== 1 && raw.v !== 2) throw new Error(`unknown snapshot version ${raw.v}`)
  let settings = DEFAULT_TRAFFIC_SETTINGS
  if (raw.v === 2) {
    const r = validSettings(raw.settings, 'the snapshot file settings')
    if (r.problem) log(`traffic settings: ${r.problem}; using the defaults`)
    settings = r.settings
  }
  let refused = 0
  let unreadable = 0
  const links = raw.links.map((l) => {
    const a = linkActionsFromRow(l.trafficActions ?? {})
    if (a.problem) refused++
    // A file written before links had passwords has no such field, and
    // `undefined` is not `null`: every link read from one would otherwise look
    // password-protected and the whole install would demand a password.
    const h = linkPasswordHashFromFile(l.passwordHash)
    if (h.problem) unreadable++
    return {
      ...l,
      expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt),
      passwordHash: h.passwordHash,
      trafficActions: a.actions,
    }
  })
  if (refused > 0) log(refusedOverrides(refused))
  if (unreadable > 0) log(unreadableHashes(unreadable))
  return new Snapshot(raw.domains, links, new Date(raw.loadedAt), 'file', settings)
}

/**
 * Write the whole file under a temporary name, fsync, rename: a reader sees
 * the old file or the new one, never half of either. A write that stops
 * short throws before the rename, so the previous file stays in place.
 * `write` is a seam for tests.
 */
export function writeSnapshotFile(path: string, s: Snapshot, write: WriteFn = writeSync): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    try {
      writeAll(fd, Buffer.from(serializeSnapshot(s)), write)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function readSnapshotFile(path: string, log: Log = () => {}): Snapshot | null {
  try {
    return deserializeSnapshot(readFileSync(path, 'utf8'), log)
  } catch {
    return null
  }
}

/**
 * How long stop() waits for a reload already in flight. A reload blocked on
 * a lock (a long DDL holder, say) must not hold the drain open: past this,
 * stopping continues and ending the pool drops the abandoned reload.
 */
export const RELOAD_STOP_WAIT_MS = 5_000

export interface SnapshotStoreOptions {
  pgUrl: string
  pool: Pool
  filePath: string
  reloadIntervalMs?: number
  debounceMs?: number
  retryMs?: number
  log?: (msg: string, err?: unknown) => void
}

export class SnapshotStore {
  private snapshot: Snapshot | null = null
  private listener: pg.Client | null = null
  private timers = new Set<NodeJS.Timeout>()
  private debounce: NodeJS.Timeout | null = null
  private stopped = false
  // Bumped at the start of every reload; a reload only assigns its result if
  // no newer reload has started since (interval, debounce and the fast retry
  // can all fire independently, and Postgres gives no ordering guarantee on
  // when each of their queries returns).
  private reloadGen = 0
  // Reloads that have started and not finished; stop() waits for them.
  private inflight = new Set<Promise<boolean>>()
  // The one seam a test uses to shorten the bound below.
  private stopWaitMs = RELOAD_STOP_WAIT_MS
  private readonly o: Required<SnapshotStoreOptions>

  constructor(opts: SnapshotStoreOptions) {
    this.o = {
      reloadIntervalMs: 60_000,
      debounceMs: 250,
      retryMs: 5000,
      log: () => {},
      ...opts,
    }
  }

  current(): Snapshot | null {
    return this.snapshot
  }

  async start(): Promise<void> {
    if (!(await this.reload())) {
      this.snapshot = readSnapshotFile(this.o.filePath, this.o.log)
      this.o.log(
        this.snapshot
          ? 'serving the last snapshot file; Postgres unreachable'
          : 'no configuration yet',
      )
    }
    const every = setInterval(() => void this.reload(), this.o.reloadIntervalMs)
    every.unref()
    this.timers.add(every)
    // Until Postgres has answered once, retry it every retryMs rather than
    // every reloadIntervalMs: on a cold start the worker may still be
    // migrating, and nothing will NOTIFY when it finishes.
    if (this.snapshot?.source !== 'postgres') {
      const fast = setInterval(() => {
        if (this.snapshot?.source === 'postgres') {
          clearInterval(fast)
          this.timers.delete(fast)
          return
        }
        void this.reload()
      }, this.o.retryMs)
      fast.unref()
      this.timers.add(fast)
    }
    void this.listen()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers.clear()
    if (this.debounce) clearTimeout(this.debounce)
    const l = this.listener
    this.listener = null
    if (l) {
      try {
        await l.end()
      } catch {
        // already gone
      }
    }
    // Once stop() resolves, no reload will start, and one in flight has
    // either finished — so the caller may end the pool, or change the
    // tables, without a reload still holding locks on them — or run past the
    // bound, in which case stopping continues without it.
    let waited: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(this.inflight),
      new Promise<void>((resolve) => {
        waited = setTimeout(resolve, this.stopWaitMs)
        waited.unref()
      }),
    ])
    clearTimeout(waited)
  }

  /** True on success. Never rejects. False, without loading, once stopped. */
  private async reload(): Promise<boolean> {
    // A notification or timer can still fire while stop() is in progress.
    if (this.stopped) return false
    const run = this.load()
    this.inflight.add(run)
    try {
      return await run
    } finally {
      this.inflight.delete(run)
    }
  }

  private async load(): Promise<boolean> {
    const gen = ++this.reloadGen
    try {
      const next = await loadFromPostgres(this.o.pool, undefined, this.o.log)
      // A newer reload already started while this one was in flight: its
      // result, whenever it lands, is the current one. Applying this older
      // result now would overwrite it with stale data.
      if (gen === this.reloadGen) {
        this.snapshot = next
        try {
          writeSnapshotFile(this.o.filePath, next)
        } catch (err) {
          this.o.log('could not write the snapshot file', err)
        }
      }
      return true
    } catch (err) {
      this.o.log('snapshot reload failed; keeping the previous one', err)
      return false
    }
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.reload(), this.o.debounceMs)
    this.debounce.unref()
  }

  /** LISTEN on a dedicated connection; reconnect with a delay when it drops. Never rejects. */
  private async listen(): Promise<void> {
    if (this.stopped) return
    const client = new pg.Client({ connectionString: this.o.pgUrl, connectionTimeoutMillis: 2000 })
    client.on('error', (err) => {
      this.o.log('config listener dropped', err)
      this.retryListen(client)
    })
    client.on('end', () => this.retryListen(client))
    client.on('notification', () => this.schedule())
    try {
      await client.connect()
      await client.query('LISTEN config_changed')
      if (this.stopped) {
        await client.end()
        return
      }
      this.listener = client
      // Anything that changed while the listener was down is picked up now.
      this.schedule()
    } catch (err) {
      this.o.log('could not start the config listener', err)
      this.retryListen(client)
    }
  }

  private retryListen(client: pg.Client): void {
    if (this.stopped) return
    if (this.listener === client) this.listener = null
    client.removeAllListeners('end')
    client.removeAllListeners('error')
    client.on('error', () => {})
    const t = setTimeout(() => {
      this.timers.delete(t)
      void this.listen()
      if (!this.snapshot) void this.reload()
    }, this.o.retryMs)
    t.unref()
    this.timers.add(t)
  }
}
