import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficSettings } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import { TEST_PG_URL, resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  Snapshot,
  SnapshotStore,
  SnapshotTooLargeError,
  deserializeSnapshot,
  linkActionsFromRow,
  loadFromPostgres,
  readSnapshotFile,
  serializeSnapshot,
  settingsFromRow,
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

  it("loads the install's traffic settings and each link's overrides", async () => {
    const { domainId } = await seed()
    await pool.query(
      `UPDATE settings SET traffic_actions = '{"bot":"block","abuser":"flag","anonymous":"safe","datacenter":"nothing"}',
                           safe_url = 'https://example.com/safe', abuser_threshold = 30`,
    )
    await pool.query(`UPDATE links SET traffic_actions = '{"bot":"nothing"}' WHERE slug = 'spring'`)
    try {
      const s = await loadFromPostgres(pool)
      expect(s.settings).toEqual({
        actions: { bot: 'block', abuser: 'flag', anonymous: 'safe', datacenter: 'nothing' },
        safeUrl: 'https://example.com/safe',
        abuserThreshold: 30,
      })
      expect(s.link(domainId, 'spring')?.trafficActions).toEqual({ bot: 'nothing' })
    } finally {
      await pool.query(
        'UPDATE settings SET traffic_actions = DEFAULT, safe_url = NULL, abuser_threshold = DEFAULT',
      )
    }
  })

  it('uses the default settings when the settings row is missing, and says so', async () => {
    await seed()
    await pool.query('TRUNCATE settings')
    const logs: string[] = []
    try {
      const s = await loadFromPostgres(pool, undefined, (m) => logs.push(m))
      expect(s.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
      expect(logs).toEqual(['traffic settings: the settings row is missing; using the defaults'])
    } finally {
      await pool.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    }
  })

  it('uses the default settings when the row passes the database checks but not the schema', async () => {
    await seed()
    // The database check allows any printable http(s) URL; core also refuses a token in the host.
    await pool.query(
      `UPDATE settings SET traffic_actions = '{"bot":"safe","abuser":"flag","anonymous":"flag","datacenter":"flag"}',
                           safe_url = 'https://{click_id}.example.com/'`,
    )
    const logs: string[] = []
    try {
      const s = await loadFromPostgres(pool, undefined, (m) => logs.push(m))
      expect(s.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatch(
        /^traffic settings: the settings row is invalid \(safeUrl: .+\); using the defaults$/,
      )
    } finally {
      await pool.query(
        'UPDATE settings SET traffic_actions = DEFAULT, safe_url = NULL, abuser_threshold = DEFAULT',
      )
    }
  })

  it('ignores an invalid link override, keeps the link, and says so once', async () => {
    const { domainId, linkId } = await seed()
    // The database check refuses every override core refuses, so it is lifted
    // for this test alone to stand in for a row written before it existed.
    await pool.query('ALTER TABLE links DROP CONSTRAINT links_traffic_actions_check')
    const logs: string[] = []
    try {
      await pool.query(`UPDATE links SET traffic_actions = '{"human":"block"}' WHERE id = $1`, [
        linkId,
      ])
      const s = await loadFromPostgres(pool, undefined, (m) => logs.push(m))
      expect(s.link(domainId, 'spring')?.trafficActions).toEqual({})
      expect(logs).toEqual(['traffic action overrides of 1 link(s) are invalid and ignored'])
    } finally {
      await pool.query("UPDATE links SET traffic_actions = '{}'")
      await pool.query(
        'ALTER TABLE links ADD CONSTRAINT links_traffic_actions_check CHECK (valid_traffic_actions(traffic_actions, false))',
      )
    }
  })

  it('logs nothing when the settings and overrides are valid', async () => {
    await seed()
    const logs: string[] = []
    await loadFromPostgres(pool, undefined, (m) => logs.push(m))
    expect(logs).toEqual([])
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

  // The one flag that decides both whether a domain's links answer and
  // whether this install will ask a certificate authority for a certificate
  // in its name. A load that carried it as true for every row would hand out
  // both to a host name nobody proved control of, and every other assertion
  // in this file seeds a verified domain, so none of them would notice.
  it('carries an unverified domain through as unverified', async () => {
    await pool.query("INSERT INTO domains (host, verified) VALUES ('new.example.test', false)")
    const s = await loadFromPostgres(pool)
    expect(s.domain('new.example.test')?.verified).toBe(false)
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

  // `undefined` is not `null`, and the evaluator asks for a password for every
  // link whose hash is not null. A file written before links had passwords has
  // no such field, so reading one must produce null rather than undefined, or
  // every link on the install becomes unanswerable.
  it('reads a link with no password hash field as no password, and carries one that has it', () => {
    const domainId = '00000000-0000-4000-8000-0000000000d1'
    const file = (over: Record<string, unknown>) =>
      JSON.stringify({
        v: 2,
        loadedAt: new Date().toISOString(),
        settings: DEFAULT_TRAFFIC_SETTINGS,
        domains: [],
        links: [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            domainId,
            slug: 'spring',
            enabled: true,
            targets: [
              {
                id: '00000000-0000-4000-8000-0000000000f1',
                url: 'https://example.com/',
                weight: 100,
              },
            ],
            backupUrl: null,
            deviceUrls: {},
            returningUrl: null,
            countries: { mode: 'all' },
            clickCap: null,
            expiresAt: null,
            passthrough: true,
            trafficActions: {},
            ...over,
          },
        ],
      })
    const older = deserializeSnapshot(file({})).link(domainId, 'spring')
    expect(older).not.toBeNull()
    // toBeNull, not a loose check: undefined is what the evaluator would read
    // as a password nobody can answer.
    expect(older?.passwordHash).toBeNull()
    // Deliberately not hash-shaped: nothing here parses it.
    const carried = deserializeSnapshot(file({ passwordHash: 'no-verifier-accepts-this' })).link(
      domainId,
      'spring',
    )
    expect(carried?.passwordHash).toBe('no-verifier-accepts-this')
  })

  it('round-trips the traffic settings', () => {
    const settings: TrafficSettings = {
      actions: { bot: 'block', abuser: 'flag', anonymous: 'safe', datacenter: 'nothing' },
      safeUrl: 'https://example.com/safe',
      abuserThreshold: 30,
    }
    const s = new Snapshot([], [], new Date(), 'postgres', settings)
    expect(deserializeSnapshot(serializeSnapshot(s)).settings).toEqual(settings)
  })

  it("refuses a version 2 file's settings and overrides that core refuses, and says so", () => {
    const link = {
      id: '00000000-0000-4000-8000-0000000000a1',
      domainId: '00000000-0000-4000-8000-0000000000d1',
      slug: 'spring',
      enabled: true,
      targets: [
        { id: '00000000-0000-4000-8000-0000000000f1', url: 'https://example.com/', weight: 100 },
      ],
      backupUrl: null,
      deviceUrls: {},
      returningUrl: null,
      countries: { mode: 'all' },
      clickCap: null,
      expiresAt: null,
      passthrough: true,
      trafficActions: { human: 'block' },
    }
    const v2 = JSON.stringify({
      v: 2,
      loadedAt: new Date().toISOString(),
      settings: {
        actions: { bot: 'safe', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' },
        safeUrl: null,
        abuserThreshold: 60,
      },
      domains: [],
      links: [link],
    })
    const logs: string[] = []
    const s = deserializeSnapshot(v2, (m) => logs.push(m))
    expect(s.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
    expect(s.link(link.domainId, 'spring')?.trafficActions).toEqual({})
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatch(
      /^traffic settings: the snapshot file settings is invalid \(actions\.bot: .+\); using the defaults$/,
    )
    expect(logs[1]).toBe('traffic action overrides of 1 link(s) are invalid and ignored')
  })

  it('reads a version 1 file as the defaults and no link overrides', () => {
    const v1 = JSON.stringify({
      v: 1,
      loadedAt: new Date().toISOString(),
      domains: [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          host: 'go.example.test',
          verified: true,
          rootUrl: null,
          notFoundUrl: null,
        },
      ],
      links: [
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          domainId: '00000000-0000-4000-8000-0000000000d1',
          slug: 'spring',
          enabled: true,
          targets: [
            {
              id: '00000000-0000-4000-8000-0000000000f1',
              url: 'https://example.com/',
              weight: 100,
            },
          ],
          backupUrl: null,
          deviceUrls: {},
          returningUrl: null,
          countries: { mode: 'all' },
          clickCap: null,
          expiresAt: null,
          passthrough: true,
        },
      ],
    })
    const s = deserializeSnapshot(v1)
    expect(s.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
    expect(s.link('00000000-0000-4000-8000-0000000000d1', 'spring')?.trafficActions).toEqual({})
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

describe('row parsers', () => {
  it('reads a valid settings row as it is', () => {
    expect(
      settingsFromRow({
        traffic_actions: { bot: 'block', abuser: 'flag', anonymous: 'flag', datacenter: 'nothing' },
        safe_url: null,
        abuser_threshold: 30,
      }),
    ).toEqual({
      settings: {
        actions: { bot: 'block', abuser: 'flag', anonymous: 'flag', datacenter: 'nothing' },
        safeUrl: null,
        abuserThreshold: 30,
      },
      problem: null,
    })
  })

  it('refuses a settings row core refuses, and says why', () => {
    const r = settingsFromRow({
      traffic_actions: { bot: 'flag', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' },
      safe_url: null,
      abuser_threshold: 0,
    })
    expect(r.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
    expect(r.problem).toMatch(/^the settings row is invalid \(abuserThreshold: .+\)$/)
  })

  it('keeps a valid link override and ignores an invalid one, saying why', () => {
    expect(linkActionsFromRow({ bot: 'block' })).toEqual({
      actions: { bot: 'block' },
      problem: null,
    })
    for (const bad of [{ human: 'block' }, { bot: 'drop' }, [], 'block', null]) {
      const r = linkActionsFromRow(bad)
      expect(r.actions).toEqual({})
      expect(r.problem).not.toBeNull()
    }
  })
})

describe('writeSnapshotFile', () => {
  const snap = (host: string) =>
    new Snapshot(
      [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          host,
          verified: true,
          rootUrl: null,
          notFoundUrl: null,
        },
      ],
      [],
      new Date(),
      'postgres',
    )

  it('finishes a short write, so the file is always whole', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    // At most seven bytes per call, as a nearly full disk might allow.
    writeSnapshotFile(path, snap('go.example.test'), (fd, buf, off, len) =>
      writeSync(fd, buf, off, Math.min(len, 7)),
    )
    expect(readSnapshotFile(path)?.domain('go.example.test')?.host).toBe('go.example.test')
  })

  it('keeps the previous file, and leaves no temporary one, when a write fails part way', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    writeSnapshotFile(path, snap('old.example.test'))
    const before = readFileSync(path, 'utf8')
    let calls = 0
    expect(() =>
      writeSnapshotFile(path, snap('new.example.test'), (fd, buf, off, len) => {
        if (++calls > 1) throw new Error('simulated write failure')
        return writeSync(fd, buf, off, Math.min(len, 7))
      }),
    ).toThrow('simulated write failure')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})

describe('SnapshotStore', () => {
  // Every store is stopped when its own test ends. A store left running
  // reloads on the next test's writes, and its reload holds locks on links
  // while it waits for domains: the next test's TRUNCATE takes them in the
  // opposite order, and Postgres aborts one of the two as a deadlock.
  const stores: SnapshotStore[] = []
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.stop()))
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

  it('passes its log to the loader, so an invalid settings row is reported', async () => {
    await seed()
    await pool.query('TRUNCATE settings')
    const logs: string[] = []
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      log: (m) => logs.push(m),
    })
    stores.push(store)
    try {
      await store.start()
      expect(logs).toContain('traffic settings: the settings row is missing; using the defaults')
    } finally {
      await store.stop()
      await pool.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    }
  })

  it('reloads when the settings change', async () => {
    await seed()
    const store = make(join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'))
    await store.start()
    expect(store.current()?.settings.abuserThreshold).toBe(60)
    // As for links below: past the listener's catch-up reload, so only the
    // notification can pick this change up.
    await until(() => (store as unknown as { listener: unknown }).listener !== null)
    await new Promise((r) => setTimeout(r, 200))
    await pool.query('UPDATE settings SET abuser_threshold = 30')
    try {
      await until(() => store.current()?.settings.abuserThreshold === 30)
    } finally {
      await pool.query('UPDATE settings SET abuser_threshold = DEFAULT')
    }
  })

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

  it('keeps the newer snapshot when an older reload finishes after it', async () => {
    const { domainId } = await seed()
    // The first connection the store takes is held after its first query,
    // the count. Its REPEATABLE READ transaction has already fixed what it
    // will read, so however late it finishes, it returns the configuration
    // from before the change below. Every query still runs on real Postgres;
    // the wrapper only adds the wait.
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let parked = () => {}
    const isParked = new Promise<void>((r) => {
      parked = r
    })
    let first = true
    const slowFirst = {
      connect: async () => {
        const client = await pool.connect()
        if (!first) return client
        first = false
        const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>
        return {
          query: async (...args: unknown[]) => {
            const result = await query(...args)
            if (String(args[0]).startsWith('SELECT count')) {
              parked()
              await gate
            }
            return result
          },
          release: () => client.release(),
        }
      },
    } as unknown as Pool
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool: slowFirst,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      log: () => {},
    })
    stores.push(store)
    // Driven directly rather than through start(), so no timer or
    // notification starts a third reload in between.
    const reload = () => (store as unknown as { reload(): Promise<boolean> }).reload()

    const older = reload()
    await isParked
    const l = await pool.query<{ id: string }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'newer') RETURNING id",
      [domainId],
    )
    await pool.query(
      "INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, 'https://example.com/n', 100, 0)",
      [l.rows[0]?.id],
    )
    expect(await reload()).toBe(true)
    expect(store.current()?.link(domainId, 'newer') ?? null).not.toBeNull()

    release()
    expect(await older).toBe(true)
    expect(store.current()?.link(domainId, 'newer') ?? null).not.toBeNull()
  })

  it('waits for a reload in flight before stop() resolves', async () => {
    await seed()
    // The store's reload is held after its first query, inside its
    // transaction, as a slow Postgres would hold it.
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let parked = () => {}
    const isParked = new Promise<void>((r) => {
      parked = r
    })
    const held = {
      connect: async () => {
        const client = await pool.connect()
        const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>
        return {
          query: async (...args: unknown[]) => {
            const result = await query(...args)
            if (String(args[0]).startsWith('SELECT count')) {
              parked()
              await gate
            }
            return result
          },
          release: () => client.release(),
        }
      },
    } as unknown as Pool
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool: held,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      log: () => {},
    })
    stores.push(store)
    const reloaded = (store as unknown as { reload(): Promise<boolean> }).reload()
    await isParked
    let stopped = false
    const stopping = store.stop().then(() => {
      stopped = true
    })
    try {
      await new Promise((r) => setTimeout(r, 100))
      expect(stopped).toBe(false)
    } finally {
      // Released even on a failed expectation: the parked reload is holding a
      // pool connection, and every later test would wait for it.
      release()
    }
    await stopping
    expect(await reloaded).toBe(true)
  })

  it('stops within the bound when a reload never finishes', async () => {
    // A pool whose connect() never settles: the reload can never finish, as
    // one blocked behind a long lock holder cannot.
    const never = { connect: () => new Promise(() => {}) } as unknown as Pool
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool: never,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      log: () => {},
    })
    stores.push(store)
    ;(store as unknown as { stopWaitMs: number }).stopWaitMs = 100
    void (store as unknown as { reload(): Promise<boolean> }).reload()
    await new Promise((r) => setTimeout(r, 20))
    const started = Date.now()
    await store.stop()
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(50)
    expect(took).toBeLessThan(2000)
  })

  it('starts no reload once stopped', async () => {
    let connects = 0
    const counting = {
      connect: async () => {
        connects++
        return pool.connect()
      },
    } as unknown as Pool
    const store = new SnapshotStore({
      pgUrl: TEST_PG_URL,
      pool: counting,
      filePath: join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json'),
      log: () => {},
    })
    stores.push(store)
    await store.stop()
    // A notification or timer that fires during or after stop() lands here.
    expect(await (store as unknown as { reload(): Promise<boolean> }).reload()).toBe(false)
    expect(connects).toBe(0)
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

  it('reports settings in the file that core refuses when it boots from the file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clickmonk-snap-')), 's.json')
    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        loadedAt: new Date().toISOString(),
        settings: { actions: {}, safeUrl: null, abuserThreshold: 60 },
        domains: [],
        links: [],
      }),
    )
    const { createPgPool } = await import('@clickmonk/db')
    const dead = 'postgres://clickmonk:clickmonk@127.0.0.1:1/none'
    const deadPool = createPgPool(dead, { connectTimeoutMs: 200 })
    const logs: string[] = []
    const store = new SnapshotStore({
      pgUrl: dead,
      pool: deadPool,
      filePath: path,
      retryMs: 50,
      log: (m) => logs.push(m),
    })
    stores.push(store)
    try {
      await store.start()
      expect(store.current()?.source).toBe('file')
      expect(store.current()?.settings).toEqual(DEFAULT_TRAFFIC_SETTINGS)
      expect(
        logs.some((m) => m.startsWith('traffic settings: the snapshot file settings is invalid')),
      ).toBe(true)
    } finally {
      await store.stop()
      await deadPool.end()
    }
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
