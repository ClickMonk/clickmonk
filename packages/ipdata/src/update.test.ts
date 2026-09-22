import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCK_FILE, takeLock } from './lock.js'
import { SOURCES, SOURCE_IDS, type SourceDef } from './sources.js'
import { IpDataStore, type Manifest, readManifest } from './store.js'
import {
  DOWNLOAD_TIMEOUT_MS,
  type FetchResult,
  type Fetcher,
  LOCK_STALE_MS,
  MAX_REDIRECTS,
  fetchBounded,
  runUpdate,
  startUpdater,
} from './update.js'

// Made-up data on the documentation ranges and ASNs. The minimums are cut to
// fit it; the real ones are tested in sources.test.ts.
const BODIES = {
  country: gzipSync('192.0.2.0,192.0.2.255,DE\n198.51.100.0,198.51.100.255,FR\n'),
  asn: gzipSync(
    '192.0.2.0,192.0.2.255,64500,"Example Home"\n198.51.100.0,198.51.100.255,64501,"Example Hosting"\n',
  ),
  datacenter: new TextEncoder().encode('ASN,Entity\n64501,Example Hosting\n'),
  tor: new TextEncoder().encode(JSON.stringify({ relays: [{ exit_addresses: ['198.51.100.9'] }] })),
}
const small = (over: Partial<SourceDef> = {}) =>
  SOURCE_IDS.map((id) => ({ ...SOURCES[id], minimum: { k32: 1, k128: 0 }, ...over }))

/** The DB-IP edition the updater tries `back` months before `now`, as the source names it. */
const edition = (now: Date, back: 0 | 1) => SOURCES.country.candidates(now)[back]?.version as string

/** Serves each source's fixture; `missing` URLs answer 404, `failing` ones throw. */
function fakeFetch(
  opts: {
    missing?: (url: string) => boolean
    failing?: (url: string) => boolean
    /** A body to serve instead of the fixture. */
    body?: (url: string) => Uint8Array | undefined
    /** Runs as each request is made. */
    onFetch?: (url: string, o: Parameters<Fetcher>[1]) => void
  } = {},
) {
  const calls: string[] = []
  const fetch: Fetcher = async (url, o) => {
    calls.push(url)
    opts.onFetch?.(url, o)
    if (opts.failing?.(url)) throw new Error('connection refused')
    if (opts.missing?.(url)) return { status: 'not_found' }
    const own = opts.body?.(url)
    if (own) return { status: 'ok', body: own }
    const id = url.includes('country')
      ? 'country'
      : url.includes('asn-lite')
        ? 'asn'
        : url.includes('bad-asn')
          ? 'datacenter'
          : 'tor'
    return { status: 'ok', body: BODIES[id] } satisfies FetchResult
  }
  return { fetch, calls }
}

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'clickmonk-update-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('runUpdate', () => {
  it('installs every source into a fresh directory, and the store reads it', async () => {
    const dir = tmp()
    const now = new Date()
    const r = await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    expect(r).toEqual([
      { id: 'country', outcome: 'updated', version: edition(now, 0) },
      { id: 'asn', outcome: 'updated', version: edition(now, 0) },
      { id: 'datacenter', outcome: 'updated', version: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { id: 'tor', outcome: 'updated', version: expect.stringMatching(/^[0-9a-f]{16}$/) },
    ])
    const store = new IpDataStore({ dir })
    await store.refresh()
    expect(store.current()?.lookup('198.51.100.9')).toMatchObject({
      country: 'FR',
      asn: 64501,
      tor: true,
      datacenter: true,
    })
  })

  it("falls back to last month's DB-IP edition while this month's is not out", async () => {
    const dir = tmp()
    const now = new Date()
    const { fetch } = fakeFetch({ missing: (u) => u.includes(edition(now, 0)) })
    const r = await runUpdate({ dir, now: () => now, fetch, sources: small() })
    expect(r).toContainEqual({ id: 'country', outcome: 'updated', version: edition(now, 1) })
  })

  it('fails a source when no edition is published, and installs the rest', async () => {
    const dir = tmp()
    const { fetch } = fakeFetch({ missing: (u) => u.includes('dbip-country') })
    const r = await runUpdate({ dir, fetch, sources: small() })
    expect(r).toContainEqual({
      id: 'country',
      outcome: 'failed',
      error: expect.stringMatching(/no edition/),
    })
    expect(Object.keys(readManifest(dir)?.sources ?? {}).sort()).toEqual([
      'asn',
      'datacenter',
      'tor',
    ])
  })

  it('keeps the table in use when a download fails or is refused', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const before = readManifest(dir)
    const { fetch } = fakeFetch({ failing: (u) => u.includes('onionoo') })
    const r = await runUpdate({ dir, now: () => now, fetch, sources: small(), force: true })
    expect(r).toContainEqual({ id: 'tor', outcome: 'failed', error: 'connection refused' })
    expect(readManifest(dir)?.sources.tor).toEqual(before?.sources.tor)
  })

  it('refuses a download smaller than a real one', async () => {
    const dir = tmp()
    const strict = small().map((d) =>
      d.id === 'datacenter' ? { ...d, minimum: { k32: 2, k128: 0 } } : d,
    )
    const r = await runUpdate({ dir, fetch: fakeFetch().fetch, sources: strict })
    expect(r).toContainEqual({
      id: 'datacenter',
      outcome: 'failed',
      error: expect.stringMatching(/fewer than/),
    })
    expect(readManifest(dir)?.sources.datacenter).toBeUndefined()
  })

  it('refuses a download that unpacks past its bound', async () => {
    const dir = tmp()
    const tight = small().map((d) => (d.id === 'country' ? { ...d, maxTextBytes: 16 } : d))
    const r = await runUpdate({ dir, fetch: fakeFetch().fetch, sources: tight })
    // The unpacking bound's own error, not a parse or minimum failure.
    expect(r).toContainEqual({
      id: 'country',
      outcome: 'failed',
      error: expect.stringMatching(/larger than 16 bytes/),
    })
  })

  it('refuses a plain download past its text bound', async () => {
    const dir = tmp()
    const tight = small().map((d) => (d.id === 'datacenter' ? { ...d, maxTextBytes: 16 } : d))
    const r = await runUpdate({ dir, fetch: fakeFetch().fetch, sources: tight })
    expect(r).toContainEqual({
      id: 'datacenter',
      outcome: 'failed',
      error: expect.stringMatching(/larger than 16 bytes/),
    })
  })

  it('aborts before any download when the manifest cannot be read, and releases the lock', async () => {
    const dir = tmp()
    // A directory in the manifest's place: an I/O error, not a bad manifest.
    mkdirSync(join(dir, 'manifest.json'))
    const f = fakeFetch()
    await expect(runUpdate({ dir, fetch: f.fetch, sources: small() })).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(f.calls).toEqual([])
    expect(existsSync(join(dir, 'update.lock'))).toBe(false)
  })

  it('treats every source as due when the manifest is invalid, and the commit heals it', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    writeFileSync(join(dir, 'manifest.json'), '{ not json')
    const r = await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    expect(r !== 'busy' && r.map((s) => s.outcome)).toEqual([
      'updated',
      'updated',
      'updated',
      'updated',
    ])
    expect(Object.keys(readManifest(dir)?.sources ?? {}).sort()).toEqual([
      'asn',
      'country',
      'datacenter',
      'tor',
    ])
  })

  it('makes no request for a source fetched within its refresh interval, unless forced', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const quiet = fakeFetch()
    const r = await runUpdate({ dir, now: () => now, fetch: quiet.fetch, sources: small() })
    expect(quiet.calls).toEqual([])
    expect(r !== 'busy' && r.map((s) => s.outcome)).toEqual([
      'not_due',
      'not_due',
      'not_due',
      'not_due',
    ])
    const forced = fakeFetch()
    await runUpdate({ dir, now: () => now, fetch: forced.fetch, sources: small(), force: true })
    expect(forced.calls.some((u) => u.includes('onionoo'))).toBe(true)
  })

  it('does not download a DB-IP edition it already has', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const again = fakeFetch()
    const r = await runUpdate({
      dir,
      now: () => now,
      fetch: again.fetch,
      sources: small(),
      force: true,
    })
    expect(again.calls.filter((u) => u.includes('db-ip'))).toEqual([])
    expect(r).toContainEqual(expect.objectContaining({ id: 'country', outcome: 'unchanged' }))
  })

  it('remembers content found unchanged, and does not fetch it again within the interval', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const checked = new Map()
    // Past Tor's refresh interval, the content is fetched and found unchanged...
    const later = now.getTime() + SOURCES.tor.refreshMs + 60_000
    const first = fakeFetch()
    await runUpdate({
      dir,
      fetch: first.fetch,
      sources: small(),
      checked,
      now: () => new Date(later),
    })
    expect(first.calls.filter((u) => u.includes('onionoo'))).toHaveLength(1)
    // ...and a minute after that it is not due again.
    const second = fakeFetch()
    const r = await runUpdate({
      dir,
      fetch: second.fetch,
      sources: small(),
      checked,
      now: () => new Date(later + 60_000),
    })
    expect(second.calls.filter((u) => u.includes('onionoo'))).toEqual([])
    expect(r).toContainEqual(expect.objectContaining({ id: 'tor', outcome: 'not_due' }))
  })

  it('reports unchanged content without writing a new manifest', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const before = readManifest(dir)
    const r = await runUpdate({
      dir,
      now: () => now,
      fetch: fakeFetch().fetch,
      sources: small(),
      force: true,
    })
    expect(r).toContainEqual(expect.objectContaining({ id: 'tor', outcome: 'unchanged' }))
    expect(readManifest(dir)).toEqual(before)
  })

  it('writes the manifest once, after every download, into a fresh directory', async () => {
    const dir = tmp()
    let seen: Manifest | null | 'unread' = 'unread'
    const { fetch } = fakeFetch({
      onFetch: (u) => {
        if (u.includes('onionoo')) seen = readManifest(dir)
      },
    })
    await runUpdate({ dir, fetch, sources: small() })
    expect(seen).toBeNull()
    expect(Object.keys(readManifest(dir)?.sources ?? {})).toHaveLength(4)
  })

  it('writes the manifest once, after every download, over an existing one', async () => {
    const dir = tmp()
    const now = new Date()
    await runUpdate({ dir, now: () => now, fetch: fakeFetch().fetch, sources: small() })
    const before = readManifest(dir)
    let seen: Manifest | null | 'unread' = 'unread'
    const { fetch } = fakeFetch({
      // A new datacenter list, fetched before Tor.
      body: (u) =>
        u.includes('bad-asn')
          ? new TextEncoder().encode('ASN,Entity\n64501,Example Hosting\n64502,Example Cloud\n')
          : undefined,
      onFetch: (u) => {
        if (u.includes('onionoo')) seen = readManifest(dir)
      },
    })
    const r = await runUpdate({ dir, now: () => now, fetch, sources: small(), force: true })
    expect(r).toContainEqual(expect.objectContaining({ id: 'datacenter', outcome: 'updated' }))
    expect(seen).toEqual(before)
    expect(readManifest(dir)?.sources.datacenter).not.toEqual(before?.sources.datacenter)
  })

  it("falls back to last month's edition when this month's is published but refused", async () => {
    const dir = tmp()
    const now = new Date()
    const { fetch } = fakeFetch({
      body: (u) =>
        u.includes(`country-lite-${edition(now, 0)}`) ? gzipSync('not,a csv\n') : undefined,
    })
    const r = await runUpdate({ dir, now: () => now, fetch, sources: small() })
    expect(r).toContainEqual({
      id: 'country',
      outcome: 'updated',
      version: edition(now, 1),
      refused: expect.stringMatching(new RegExp(`^${edition(now, 0)} refused: `)),
    })
  })

  it("keeps last month's edition installed while this month's is refused, and says why", async () => {
    const dir = tmp()
    const now = new Date()
    const refuseThisMonth = () =>
      fakeFetch({
        body: (u) =>
          u.includes(`country-lite-${edition(now, 0)}`) ? gzipSync('not,a csv\n') : undefined,
      })
    await runUpdate({ dir, now: () => now, fetch: refuseThisMonth().fetch, sources: small() })
    const again = refuseThisMonth()
    const r = await runUpdate({
      dir,
      now: () => now,
      fetch: again.fetch,
      sources: small(),
      force: true,
    })
    expect(r).toContainEqual({
      id: 'country',
      outcome: 'unchanged',
      version: edition(now, 1),
      refused: expect.stringMatching(new RegExp(`^${edition(now, 0)} refused: `)),
    })
    // Last month's is the one installed: it is not downloaded again.
    expect(again.calls.filter((u) => u.includes(`country-lite-${edition(now, 1)}`))).toEqual([])
    // The worker reports the refusal on each check, not only the first.
    const m = readManifest(dir)
    const old = new Date(now.getTime() - SOURCES.country.refreshMs - 60_000).toISOString()
    if (m?.sources.country) m.sources.country.fetchedAt = old
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
    const lines: string[] = []
    let passed: () => void = () => {}
    const firstPass = new Promise<void>((res) => {
      passed = res
    })
    const u = startUpdater({
      dir,
      fetch: refuseThisMonth().fetch,
      sources: small(),
      log: (msg) => {
        lines.push(msg)
        if (msg.startsWith('IP data country')) passed()
      },
    })
    await firstPass
    await u.stop()
    expect(lines).toEqual([
      expect.stringMatching(
        new RegExp(`^IP data country: ${edition(now, 0)} refused: .*; using ${edition(now, 1)}$`),
      ),
    ])
  })

  it('fails a source when every published edition is refused', async () => {
    const dir = tmp()
    const now = new Date()
    const { fetch } = fakeFetch({
      body: (u) => (u.includes('country-lite') ? gzipSync('not,a csv\n') : undefined),
    })
    const r = await runUpdate({ dir, now: () => now, fetch, sources: small() })
    expect(r).toContainEqual({
      id: 'country',
      outcome: 'failed',
      error: expect.stringMatching(
        new RegExp(`${edition(now, 0)} refused: .*; ${edition(now, 1)} refused: `),
      ),
    })
    expect(readManifest(dir)?.sources.country).toBeUndefined()
  })

  it('caps a plain download at its text bound, and waits two minutes by default', async () => {
    const dir = tmp()
    const seen = new Map<string, Parameters<Fetcher>[1]>()
    const { fetch } = fakeFetch({ onFetch: (u, o) => seen.set(u, o) })
    await runUpdate({ dir, fetch, sources: small() })
    const opts = [...seen.entries()]
    const tor = opts.find(([u]) => u.includes('onionoo'))?.[1]
    const country = opts.find(([u]) => u.includes('country-lite'))?.[1]
    // Tor is plain and may download far more than it may parse.
    expect(SOURCES.tor.maxDownloadBytes).toBeGreaterThan(SOURCES.tor.maxTextBytes)
    expect(tor?.maxBytes).toBe(SOURCES.tor.maxTextBytes)
    expect(country?.maxBytes).toBe(SOURCES.country.maxDownloadBytes)
    expect(DOWNLOAD_TIMEOUT_MS).toBe(120_000)
    expect(opts.every(([, o]) => o.timeoutMs === 120_000)).toBe(true)
  })

  it("reports a network error's cause", async () => {
    const dir = tmp()
    // A port that was just free: nothing listens on it.
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))
    const tor = {
      ...SOURCES.tor,
      minimum: { k32: 1, k128: 0 },
      candidates: () => [{ url: `http://127.0.0.1:${port}/details`, version: null }],
    }
    const r = await runUpdate({ dir, sources: [tor], timeoutMs: 5000 })
    expect(r).toEqual([
      { id: 'tor', outcome: 'failed', error: expect.stringMatching(/ECONNREFUSED/) },
    ])
  })

  it('stands aside while another update holds the lock, and takes over a stale one', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'update.lock'), JSON.stringify({ pid: 1, at: Date.now() }))
    expect(await runUpdate({ dir, fetch: fakeFetch().fetch, sources: small() })).toBe('busy')
    expect(existsSync(join(dir, 'update.lock'))).toBe(true)
    writeFileSync(
      join(dir, 'update.lock'),
      JSON.stringify({ pid: 1, at: Date.now() - LOCK_STALE_MS - 1 }),
    )
    expect(
      Array.isArray(await runUpdate({ dir, fetch: fakeFetch().fetch, sources: small() })),
    ).toBe(true)
    expect(readdirSync(dir)).not.toContain('update.lock')
  })
})

describe('takeLock', () => {
  const stale = () => JSON.stringify({ pid: 1, at: Date.now() - LOCK_STALE_MS - 1 })

  it('takes over a stale lock, and leaves nothing else behind', () => {
    const dir = tmp()
    writeFileSync(join(dir, LOCK_FILE), stale())
    const now = Date.now()
    expect(takeLock(dir, now)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toEqual({
      pid: process.pid,
      at: now,
    })
    expect(readdirSync(dir)).toEqual([LOCK_FILE])
  })

  it('backs off, and puts the lock back, when another process took the stale lock over first', () => {
    const dir = tmp()
    writeFileSync(join(dir, LOCK_FILE), stale())
    const theirs = JSON.stringify({ pid: 2, at: Date.now() })
    // Between this call reading the stale lock and renaming it, another
    // process replaced it with its own: the file renamed is that live lock.
    const took = takeLock(dir, Date.now(), {
      afterRename: (renamed) => writeFileSync(renamed, theirs),
    })
    expect(took).toBe(false)
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(theirs)
    expect(readdirSync(dir)).toEqual([LOCK_FILE])
  })

  it('backs off, and leaves the newest lock in place, when a third took the name meanwhile', () => {
    const dir = tmp()
    writeFileSync(join(dir, LOCK_FILE), stale())
    const theirs = JSON.stringify({ pid: 2, at: Date.now() })
    const newest = JSON.stringify({ pid: 3, at: Date.now() })
    const took = takeLock(dir, Date.now(), {
      afterRename: (renamed) => {
        writeFileSync(renamed, theirs)
        // By the time the renamed lock would go back, a newer one holds the name.
        writeFileSync(join(dir, LOCK_FILE), newest)
      },
    })
    expect(took).toBe(false)
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(newest)
    expect(readdirSync(dir)).toEqual([LOCK_FILE])
  })

  it('does not take a lock with no time for stale while its file is new', () => {
    const dir = tmp()
    // As a lock created in place looks before its content is written.
    writeFileSync(join(dir, LOCK_FILE), '')
    expect(takeLock(dir, Date.now())).toBe(false)
  })

  it('creates the lock in place where the filesystem has no hard links, and says so once', () => {
    const dir = tmp()
    const lines: string[] = []
    const link = () => {
      throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
    }
    const now = Date.now()
    expect(takeLock(dir, now, { link, log: (m) => lines.push(m) })).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toEqual({
      pid: process.pid,
      at: now,
    })
    expect(readdirSync(dir)).toEqual([LOCK_FILE])
    // Held: a second call stands aside.
    expect(takeLock(dir, now, { link, log: (m) => lines.push(m) })).toBe(false)
    expect(lines).toEqual([expect.stringMatching(/has no hard links/)])
  })

  it('still refuses any other link error', () => {
    const dir = tmp()
    const link = () => {
      throw Object.assign(new Error('i/o error'), { code: 'EIO' })
    }
    expect(() => takeLock(dir, Date.now(), { link })).toThrow(/i\/o error/)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('startUpdater', () => {
  it('runs once at start, and reports each source it installed', async () => {
    const dir = tmp()
    const lines: string[] = []
    let passed: () => void = () => {}
    // Resolved by the pass's own report, not by a timer.
    const firstPass = new Promise<void>((r) => {
      passed = r
    })
    const log = (m: string) => {
      lines.push(m)
      if (lines.length === 4) passed()
    }
    const u = startUpdater({
      dir,
      fetch: fakeFetch().fetch,
      sources: small(),
      intervalMs: 3_600_000,
      log,
    })
    await firstPass
    await u.stop()
    expect(Object.keys(readManifest(dir)?.sources ?? {})).toHaveLength(4)
    expect(lines.every((l) => /^IP data \w+ updated to /.test(l))).toBe(true)
  })

  it('logs a run the manifest stopped, and releases the lock', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'manifest.json'))
    const lines: { msg: string; err?: unknown }[] = []
    let passed: () => void = () => {}
    const firstPass = new Promise<void>((r) => {
      passed = r
    })
    const log = (msg: string, err?: unknown) => {
      lines.push({ msg, err })
      passed()
    }
    const u = startUpdater({ dir, fetch: fakeFetch().fetch, sources: small(), log })
    await firstPass
    await u.stop()
    expect(lines).toEqual([
      { msg: 'IP data update failed', err: expect.objectContaining({ code: 'EISDIR' }) },
    ])
    expect(existsSync(join(dir, 'update.lock'))).toBe(false)
  })

  it('keeps going when its log throws', async () => {
    const dir = tmp()
    const lines: string[] = []
    let passed: () => void = () => {}
    const firstPass = new Promise<void>((r) => {
      passed = r
    })
    const log = (m: string) => {
      lines.push(m)
      if (lines.length === 4) passed()
      throw new Error('log is broken')
    }
    const u = startUpdater({ dir, fetch: fakeFetch().fetch, sources: small(), log })
    await firstPass
    await expect(u.stop()).resolves.toBeUndefined()
    expect(lines).toHaveLength(4)
  })

  it('logs a refused edition, and the one it used instead', async () => {
    const dir = tmp()
    const now = new Date()
    const lines: string[] = []
    let passed: () => void = () => {}
    const firstPass = new Promise<void>((r) => {
      passed = r
    })
    const log = (m: string) => {
      lines.push(m)
      if (m.startsWith('IP data tor ')) passed()
    }
    const { fetch } = fakeFetch({
      body: (u) =>
        u.includes(`country-lite-${edition(now, 0)}`) ? gzipSync('not,a csv\n') : undefined,
    })
    const u = startUpdater({ dir, fetch, sources: small(), log })
    await firstPass
    await u.stop()
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(`^IP data country: ${edition(now, 0)} refused: .*; using ${edition(now, 1)}$`),
      ),
    )
  })

  it('aborts a download in flight when stopped, and releases the lock', async () => {
    const dir = tmp()
    let started: () => void = () => {}
    const inFlight = new Promise<void>((r) => {
      started = r
    })
    let calls = 0
    // A server that never answers: only the abort can end this download.
    const hang: Fetcher = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        calls++
        if (signal?.aborted) return reject(new Error('aborted'))
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
        started()
      })
    const u = startUpdater({ dir, fetch: hang, sources: small() })
    await inFlight
    expect(existsSync(join(dir, 'update.lock'))).toBe(true)
    await u.stop()
    expect(existsSync(join(dir, 'update.lock'))).toBe(false)
    expect(readManifest(dir)).toBeNull()
    // Stopping started no further download.
    expect(calls).toBe(1)
  })
})

describe('fetchBounded', () => {
  let server: http.Server
  let base = ''
  let port = 0
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end('hello')
      if (req.url === '/missing') return res.writeHead(404).end()
      if (req.url === '/broken') return res.writeHead(500).end()
      if (req.url === '/declared-big')
        return res.writeHead(200, { 'content-length': '100' }).end('x'.repeat(100))
      if (req.url === '/streamed-big') {
        res.writeHead(200)
        res.write('x'.repeat(60))
        res.end('x'.repeat(60))
        return
      }
      const hop = req.url?.match(/^\/hops\/(\d+)$/)
      if (hop) {
        const n = Number(hop[1])
        // Relative, as a server may send it.
        return res.writeHead(302, { location: n > 1 ? `/hops/${n - 1}` : '/ok' }).end()
      }
      if (req.url === '/to-https') {
        return res.writeHead(301, { location: `https://127.0.0.1:${port}/ok` }).end()
      }
      if (req.url === '/no-location') return res.writeHead(302).end()
      if (req.url === '/nested/start')
        return res.writeHead(302, { location: '/nested/dir/rel' }).end()
      // No leading slash: relative to this hop's own path, not the first one's.
      if (req.url === '/nested/dir/rel') return res.writeHead(302, { location: 'ok' }).end()
      if (req.url === '/nested/dir/ok') return res.end('nested')
      // /slow: never answers.
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  const get = (path: string, timeoutMs = 5000) =>
    fetchBounded(`${base}${path}`, { maxBytes: 50, timeoutMs })

  it('returns the body', async () => {
    const r = await get('/ok')
    expect(r.status === 'ok' && Buffer.from(r.body).toString()).toBe('hello')
  })

  it('answers not_found for a 404, and throws for any other failure', async () => {
    expect(await get('/missing')).toEqual({ status: 'not_found' })
    await expect(get('/broken')).rejects.toThrow(/HTTP 500/)
  })

  it('refuses a body over the bound, declared or streamed', async () => {
    await expect(get('/declared-big')).rejects.toThrow(/declares 100 bytes/)
    await expect(get('/streamed-big')).rejects.toThrow(/larger than 50/)
  })

  it('resolves a relative location against the hop that sent it', async () => {
    const r = await get('/nested/start')
    expect(r.status === 'ok' && Buffer.from(r.body).toString()).toBe('nested')
  })

  it('follows a redirect to the same scheme, up to its bound', async () => {
    const r = await get(`/hops/${MAX_REDIRECTS}`)
    expect(r.status === 'ok' && Buffer.from(r.body).toString()).toBe('hello')
    expect(MAX_REDIRECTS).toBe(3)
  })

  it('refuses one redirect too many', async () => {
    await expect(get(`/hops/${MAX_REDIRECTS + 1}`)).rejects.toThrow(/more than 3 redirects/)
  })

  // The rule is that a redirect keeps the original URL's scheme, which is
  // what forbids https to http. The fixture server is plain http, so the
  // test shows the rule refusing a change of scheme in the other direction.
  it('refuses a redirect to another scheme', async () => {
    await expect(get('/to-https')).rejects.toThrow(
      /redirect to https: refused, only http: is followed/,
    )
  })

  it('refuses a redirect without a location', async () => {
    await expect(get('/no-location')).rejects.toThrow(/HTTP 302 without a location/)
  })

  // Its subject is the time bound itself, so it lets that timer fire.
  it('gives up on a server that does not answer', async () => {
    await expect(get('/slow', 200)).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('still gives up at its time bound when it has a signal', async () => {
    const c = new AbortController()
    const r = fetchBounded(`${base}/slow`, { maxBytes: 50, timeoutMs: 200, signal: c.signal })
    await expect(r).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('gives up when its signal aborts', async () => {
    const c = new AbortController()
    // A time bound far past the test's own timeout: only the signal can end it.
    const r = fetchBounded(`${base}/slow`, { maxBytes: 50, timeoutMs: 600_000, signal: c.signal })
    c.abort()
    await expect(r).rejects.toMatchObject({ name: 'AbortError' })
  })
})
