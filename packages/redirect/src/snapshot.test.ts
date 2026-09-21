import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  SnapshotStore,
  SnapshotTooLargeError,
  deserializeSnapshot,
  loadFromPostgres,
  readSnapshotFile,
  serializeSnapshot,
  writeSnapshotFile,
} from './snapshot.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

beforeEach(async () => {
  await pool.query('TRUNCATE domains CASCADE')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

async function seed() {
  const d = await pool.query<{ id: string }>(
    "INSERT INTO domains (host, verified, root_url) VALUES ('go.example.test', true, 'https://example.com/') RETURNING id",
  )
  const domainId = d.rows[0]?.id as string
  const l = await pool.query<{ id: string }>(
    `INSERT INTO links (domain_id, slug, backup_url, device_urls, countries, click_cap, expires_at, passthrough)
     VALUES ($1, 'spring', 'https://example.com/b', '{"ios":"https://example.com/ios"}',
             '{"mode":"block","list":["DE"]}', 10, now() + interval '1 day', false)
     RETURNING id`,
    [domainId],
  )
  const linkId = l.rows[0]?.id as string
  await pool.query(
    `INSERT INTO link_targets (link_id, url, weight, position) VALUES
       ($1, 'https://example.com/second', 30, 1), ($1, 'https://example.com/first', 70, 0)`,
    [linkId],
  )
  return { domainId, linkId }
}

// Every predicate passed here must be false while the store has no snapshot:
// `store.current()?.link(...) !== null` is TRUE when current() is null
// (undefined !== null), and would pass without the store loading anything.
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

describe('loadFromPostgres', () => {
  it('maps every column, and orders targets by position', async () => {
    const { domainId, linkId } = await seed()
    const s = await loadFromPostgres(pool)
    expect(s.source).toBe('postgres')
    expect(s.domain('go.example.test')).toMatchObject({
      id: domainId,
      verified: true,
      rootUrl: 'https://example.com/',
    })
    const link = s.link(domainId, 'spring')
    expect(link).toMatchObject({
      id: linkId,
      backupUrl: 'https://example.com/b',
      deviceUrls: { ios: 'https://example.com/ios' },
      countries: { mode: 'block', list: ['DE'] },
      clickCap: 10,
      passthrough: false,
    })
    expect(link?.expiresAt).toBeInstanceOf(Date)
    expect(link?.targets.map((t) => [t.url, t.weight])).toEqual([
      ['https://example.com/first', 70],
      ['https://example.com/second', 30],
    ])
  })

  it('omits a link with no targets rather than serving it', async () => {
    const { domainId } = await seed()
    await pool.query("INSERT INTO links (domain_id, slug) VALUES ($1, 'empty')", [domainId])
    expect((await loadFromPostgres(pool)).link(domainId, 'empty')).toBeNull()
  })

  it('refuses a snapshot larger than the bound', async () => {
    await seed()
    await expect(loadFromPostgres(pool, 0)).rejects.toBeInstanceOf(SnapshotTooLargeError)
  })

  it('looks slugs up case-sensitively and hosts exactly', async () => {
    const { domainId } = await seed()
    const s = await loadFromPostgres(pool)
    expect(s.link(domainId, 'SPRING')).toBeNull()
    expect(s.domain('GO.example.test')).toBeNull()
  })
})

describe('snapshot file', () => {
  it('round-trips, including dates', async () => {
    const { domainId } = await seed()
    const s = await loadFromPostgres(pool)
    const back = deserializeSnapshot(serializeSnapshot(s))
    expect(back.link(domainId, 'spring')).toEqual(s.link(domainId, 'spring'))
    expect(back.source).toBe('file')
  })

  it('writes atomically and reads back; a corrupt file reads as null', async () => {
    await seed()
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-snap-'))
    const path = join(dir, 'snapshot.json')
    writeSnapshotFile(path, await loadFromPostgres(pool))
    expect(readSnapshotFile(path)?.size.links).toBe(1)
    writeFileSync(path, '{not json')
    expect(readSnapshotFile(path)).toBeNull()
    expect(readSnapshotFile(join(dir, 'missing.json'))).toBeNull()
  })
})

describe('SnapshotStore', () => {
  const stores: SnapshotStore[] = []
  afterAll(async () => {
    for (const s of stores) await s.stop()
  })
  const make = (filePath: string, pgUrl = TEST_PG_URL, p = pool) => {
    const s = new SnapshotStore({
      pgUrl,
      pool: p,
      filePath,
      debounceMs: 20,
      retryMs: 50,
      log: () => {},
    })
    stores.push(s)
    return s
  }

  it('reloads when a link changes', async () => {
    const { domainId } = await seed()
    const store = make(join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'))
    await store.start()
    expect(store.current()?.link(domainId, 'new')).toBeNull()
    // Wait for the listener to be connected, and past its own catch-up
    // reload, so this change is picked up by the NOTIFY path, not by the
    // catch-up: a change made before the catch-up lands is picked up by the
    // catch-up, not the notification, and would pass this test either way.
    await until(() => (store as unknown as { listener: unknown }).listener !== null)
    await new Promise((r) => setTimeout(r, 200))
    const l = await pool.query<{ id: string }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'new') RETURNING id",
      [domainId],
    )
    await pool.query(
      "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/n', 100, 0)",
      [l.rows[0]?.id],
    )
    await until(() => (store.current()?.link(domainId, 'new') ?? null) !== null)
  })

  it('reloads what changed while the listener was down, once it connects', async () => {
    const { domainId } = await seed()
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    // A real pool (so the initial load, and the eventual reload, succeed) but
    // an unreachable pgUrl (so LISTEN never connects until it is pointed at
    // the real database below).
    const store = new SnapshotStore({
      pgUrl: 'postgres://clickmonk:clickmonk@127.0.0.1:1/none',
      pool,
      filePath: path,
      debounceMs: 20,
      retryMs: 50,
      log: () => {},
    })
    stores.push(store)
    await store.start()
    expect(store.current()?.source).toBe('postgres')
    const l = await pool.query<{ id: string }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'late') RETURNING id",
      [domainId],
    )
    await pool.query(
      "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/late', 100, 0)",
      [l.rows[0]?.id],
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(store.current()?.link(domainId, 'late')).toBeNull()
    // The worker (a stand-in) becomes reachable: the listener can now
    // connect, and on connecting, its catch-up reload picks up what changed
    // while it was down. Nothing NOTIFIES for this change: the listener was
    // never up to hear it.
    ;(store as unknown as { o: { pgUrl: string } }).o.pgUrl = TEST_PG_URL
    await until(() => (store.current()?.link(domainId, 'late') ?? null) !== null)
  })

  it('keeps the previous snapshot when a reload fails', async () => {
    const { domainId } = await seed()
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool,
      filePath: path,
      debounceMs: 20,
      retryMs: 50,
      reloadIntervalMs: 50,
      log: () => {},
    })
    stores.push(store)
    await store.start()
    expect(store.current()?.link(domainId, 'spring')).not.toBeNull()
    const { createPgPool } = await import('@clickmonk/db')
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 200,
    })
    ;(store as unknown as { o: { pool: unknown } }).o.pool = dead
    // The 50 ms interval fires several times against the dead pool while we
    // wait; none of those failures may clear what is already loaded.
    await new Promise((r) => setTimeout(r, 500))
    expect(store.current()?.link(domainId, 'spring') ?? null).not.toBeNull()
    await store.stop()
    await dead.end()
  })

  it('writes the snapshot file on every successful load', async () => {
    await seed()
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    const store = make(path)
    await store.start()
    expect(readSnapshotFile(path)?.size.domains).toBe(1)
  })

  it('boots from the file when Postgres is unreachable', async () => {
    const { domainId } = await seed()
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    writeSnapshotFile(path, await loadFromPostgres(pool))
    const { createPgPool } = await import('@clickmonk/db')
    const dead = 'postgres://clickmonk:clickmonk@127.0.0.1:1/none'
    const deadPool = createPgPool(dead, { connectTimeoutMs: 200 })
    const store = make(path, dead, deadPool)
    await store.start()
    expect(store.current()?.source).toBe('file')
    expect(store.current()?.link(domainId, 'spring')).not.toBeNull()
    await store.stop()
    await deadPool.end()
  })

  it('picks Postgres up within retryMs once it becomes reachable, without a notification', async () => {
    const { domainId } = await seed()
    const { createPgPool } = await import('@clickmonk/db')
    const dead = createPgPool('postgres://clickmonk:clickmonk@127.0.0.1:1/none', {
      connectTimeoutMs: 200,
    })
    // Starts against a dead pool, then the pool is swapped for a live one:
    // the stand-in for "the worker finished migrating".
    const opts = {
      pgUrl: TEST_PG_URL,
      pool: dead,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      debounceMs: 20,
      retryMs: 50,
      reloadIntervalMs: 600_000,
      log: () => {},
    }
    const store = new SnapshotStore(opts)
    stores.push(store)
    await store.start()
    expect(store.current()).toBeNull()
    // Let the listener connect (pgUrl is live) and its catch-up reload fail
    // against the dead pool. After that, only the retry interval can load the
    // snapshot: nothing will NOTIFY and the full reload is ten minutes away.
    await new Promise((r) => setTimeout(r, 500))
    expect(store.current()).toBeNull()
    // Reaches into the store's private options on purpose: it is the one
    // seam that lets a test flip Postgres from dead to alive mid-run.
    ;(store as unknown as { o: { pool: unknown } }).o.pool = pool
    await until(
      () =>
        store.current()?.source === 'postgres' &&
        (store.current()?.link(domainId, 'spring') ?? null) !== null,
    )
    await dead.end()
  })

  it('starts empty, without throwing, when neither Postgres nor a file is available', async () => {
    const { createPgPool } = await import('@clickmonk/db')
    const dead = 'postgres://clickmonk:clickmonk@127.0.0.1:1/none'
    const deadPool = createPgPool(dead, { connectTimeoutMs: 200 })
    const store = make(
      join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 'none.json'),
      dead,
      deadPool,
    )
    await store.start()
    expect(store.current()).toBeNull()
    await store.stop()
    await deadPool.end()
  })
})
