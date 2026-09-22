import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import type { CountryRule, Device, Domain, Link } from '@clickmonk/core'
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
  targets: { id: string; url: string; weight: number }[] | null
}

/**
 * One REPEATABLE READ READ ONLY transaction on one connection, so the count,
 * the domains and the links are all a consistent view of the same instant.
 * Three queries on separate pool connections could each see a different
 * commit in between (a target inserted after the count, say), producing a
 * snapshot that never existed in Postgres.
 */
export async function loadFromPostgres(pool: Pool, maxLinks = 2_000_000): Promise<Snapshot> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM links')
      const n = Number(count.rows[0]?.n ?? 0)
      if (n > maxLinks) throw new SnapshotTooLargeError(n, maxLinks)

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
               l.countries, l.click_cap, l.expires_at, l.passthrough,
               json_agg(json_build_object('id', t.id, 'url', t.url, 'weight', t.weight)
                        ORDER BY t.position) FILTER (WHERE t.id IS NOT NULL) AS targets
          FROM links l
          LEFT JOIN link_targets t ON t.link_id = l.id
         GROUP BY l.id`)

      await client.query('COMMIT')

      return new Snapshot(
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
          })),
        new Date(),
        'postgres',
      )
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

export function serializeSnapshot(s: Snapshot): string {
  return JSON.stringify({ v: 1, loadedAt: s.loadedAt.toISOString(), ...s.entries() })
}

export function deserializeSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as {
    v: number
    loadedAt: string
    domains: Domain[]
    links: (Omit<Link, 'expiresAt'> & { expiresAt: string | null })[]
  }
  if (raw.v !== 1) throw new Error(`unknown snapshot version ${raw.v}`)
  return new Snapshot(
    raw.domains,
    raw.links.map((l) => ({
      ...l,
      expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt),
    })),
    new Date(raw.loadedAt),
    'file',
  )
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

export function readSnapshotFile(path: string): Snapshot | null {
  try {
    return deserializeSnapshot(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

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
      this.snapshot = readSnapshotFile(this.o.filePath)
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
  }

  /** True on success. Never rejects. */
  private async reload(): Promise<boolean> {
    const gen = ++this.reloadGen
    try {
      const next = await loadFromPostgres(this.o.pool)
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
