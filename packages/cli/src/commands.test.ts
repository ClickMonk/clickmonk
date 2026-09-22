import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { type Fetcher, SOURCES, SOURCE_IDS } from '@clickmonk/ipdata'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './commands.js'

const pg = testPg()
const ch = testCh()
const lines: string[] = []
const ipdataDir = mkdtempSync(join(tmpdir(), 'clickmonk-cli-ipdata-'))
const run = (...argv: string[]) =>
  runCli(argv, { pg, ch: () => ch, out: (s) => lines.push(s), ipdata: { dir: ipdataDir } })

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('clickmonk cli', () => {
  it('migrate is idempotent', async () => {
    expect(await run('migrate')).toBe(0)
    expect(await run('migrate')).toBe(0)
  })

  it('adds a domain, normalised and marked verified, and says why', async () => {
    lines.length = 0
    expect(
      await run('domain', 'add', 'Go.Example.TEST.', '--root-url', 'https://example.com/'),
    ).toBe(0)
    const r = await pg.query('SELECT host, verified, root_url FROM domains')
    expect(r.rows).toEqual([
      { host: 'go.example.test', verified: true, root_url: 'https://example.com/' },
    ])
    expect(lines.join('\n')).toMatch(/^domain go\.example\.test [0-9a-f-]{36}$/m)
    expect(lines.join('\n')).toMatch(/verified without a DNS check/)
  })

  it('rejects a bad host and a bad fallback URL', async () => {
    expect(await run('domain', 'add', 'not a host')).toBe(2)
    expect(await run('domain', 'add', 'x.example.test', '--root-url', 'javascript:alert(1)')).toBe(
      2,
    )
  })

  it('rejects a token in a domain URL, which would be sent unrendered, and writes nothing', async () => {
    const url = 'https://example.com/?c={click_id}'
    expect(await run('domain', 'add', 'root.example.test', '--root-url', url)).toBe(2)
    expect(await run('domain', 'add', 'nf.example.test', '--not-found-url', url)).toBe(2)
    const r = await pg.query('SELECT 1 FROM domains WHERE host IN ($1, $2)', [
      'root.example.test',
      'nf.example.test',
    ])
    expect(r.rowCount).toBe(0)
  })

  it('adds a link with weighted targets, a cap, an expiry and no passthrough', async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString()
    const code = await run(
      'link',
      'add',
      'go.example.test',
      'spring',
      '--target',
      '70=https://example.com/a',
      '--target',
      '30=https://example.com/b',
      '--backup',
      'https://example.com/backup',
      '--cap',
      '500',
      '--expires',
      expires,
      '--no-passthrough',
    )
    expect(code).toBe(0)
    const l = await pg.query(
      'SELECT slug, click_cap, passthrough, backup_url, expires_at FROM links',
    )
    expect(l.rows[0]).toMatchObject({
      slug: 'spring',
      click_cap: '500',
      passthrough: false,
      backup_url: 'https://example.com/backup',
    })
    const t = await pg.query('SELECT url, weight, position FROM link_targets ORDER BY position')
    expect(t.rows).toEqual([
      { url: 'https://example.com/a', weight: 70, position: 0 },
      { url: 'https://example.com/b', weight: 30, position: 1 },
    ])
  })

  it('never reads a weight out of the URL itself', async () => {
    expect(
      await run('link', 'add', 'go.example.test', 'q', '--target', 'https://example.com/?a=1'),
    ).toBe(0)
    const t = await pg.query(
      "SELECT t.url, t.weight FROM link_targets t JOIN links l ON l.id = t.link_id WHERE l.slug = 'q'",
    )
    expect(t.rows[0]).toEqual({ url: 'https://example.com/?a=1', weight: 100 })
  })

  it('rejects weights that do not sum to 100, and writes nothing', async () => {
    const before = await pg.query('SELECT count(*)::int AS n FROM links')
    const code = await run(
      'link',
      'add',
      'go.example.test',
      'bad',
      '--target',
      '50=https://example.com/a',
      '--target',
      '40=https://example.com/b',
    )
    expect(code).toBe(2)
    const after = await pg.query('SELECT count(*)::int AS n FROM links')
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
  })

  it('rejects a link on an unknown domain, and a duplicate slug', async () => {
    expect(
      await run('link', 'add', 'nope.example.test', 'x', '--target', 'https://example.com/'),
    ).toBe(2)
    expect(
      await run('link', 'add', 'go.example.test', 'spring', '--target', 'https://example.com/'),
    ).toBe(2)
  })

  it('needs ClickHouse only for migrate', async () => {
    const noCh = () => {
      throw new Error('ClickHouse is not configured')
    }
    const code = await runCli(['domain', 'add', 'noch.example.test'], {
      pg,
      ch: noCh,
      out: () => {},
      ipdata: { dir: ipdataDir },
    })
    expect(code).toBe(0)
  })

  it('prints usage and exits 1 on an unknown command', async () => {
    lines.length = 0
    expect(await run('frobnicate')).toBe(1)
    expect(lines.join('\n')).toMatch(/usage/i)
  })
})

describe('clickmonk ipdata', () => {
  // Made-up data on the documentation ranges and ASNs, with minimums cut to fit.
  const bodies: Record<string, Uint8Array> = {
    country: gzipSync('192.0.2.0,192.0.2.255,DE\n'),
    asn: gzipSync('192.0.2.0,192.0.2.255,64500,"Example"\n'),
    datacenter: new TextEncoder().encode('ASN,Entity\n64501,Example Hosting\n'),
    tor: new TextEncoder().encode('{"relays":[{"exit_addresses":["198.51.100.9"]}]}'),
  }
  const sources = SOURCE_IDS.map((id) => ({ ...SOURCES[id], minimum: { k32: 1, k128: 0 } }))
  const fetchAll =
    (failTor = false): Fetcher =>
    async (url) => {
      if (failTor && url.includes('onionoo')) throw new Error('connection refused')
      const id = url.includes('country')
        ? 'country'
        : url.includes('asn-lite')
          ? 'asn'
          : url.includes('bad-asn')
            ? 'datacenter'
            : 'tor'
      return { status: 'ok', body: bodies[id] as Uint8Array }
    }
  const ip = (dir: string, fetch: Fetcher, ...argv: string[]) =>
    runCli(argv, { pg, ch: () => ch, out: (s) => lines.push(s), ipdata: { dir, fetch, sources } })

  it('says what is missing before the first update', async () => {
    lines.length = 0
    expect(await run('ipdata', 'status')).toBe(0)
    expect(lines).toContain('country: dbip-country-lite, not downloaded yet')
    expect(lines.some((l) => l.includes('https://'))).toBe(false)
  })

  it('downloads every source, then reports each with its attribution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-cli-ipdata-'))
    lines.length = 0
    expect(await ip(dir, fetchAll(), 'ipdata', 'update')).toBe(0)
    expect(lines.filter((l) => /: updated /.test(l))).toHaveLength(4)
    lines.length = 0
    expect(await ip(dir, fetchAll(), 'ipdata', 'status')).toBe(0)
    expect(lines.join('\n')).toMatch(
      /^country: dbip-country-lite \d{4}-\d{2}, fetched .+, 1 \+ 0 entries$/m,
    )
    expect(
      lines.filter((l) => l.startsWith('IP Geolocation by DB-IP (https://db-ip.com)')),
    ).toHaveLength(1)
    // Run again at once: the update is forced, so no source is skipped as not due.
    lines.length = 0
    expect(await ip(dir, fetchAll(), 'ipdata', 'update')).toBe(0)
    expect(lines).toHaveLength(4)
    expect(lines.filter((l) => /not_due/.test(l))).toEqual([])
  })

  it('exits 4 when a source fails, and still installs the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-cli-ipdata-'))
    lines.length = 0
    expect(await ip(dir, fetchAll(true), 'ipdata', 'update')).toBe(4)
    expect(lines).toContain('tor: failed (connection refused)')
    expect(lines.filter((l) => /: updated /.test(l))).toHaveLength(3)
  })

  it('exits 4 while another update holds the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-cli-ipdata-'))
    writeFileSync(join(dir, 'update.lock'), JSON.stringify({ at: Date.now() }))
    lines.length = 0
    expect(await ip(dir, fetchAll(), 'ipdata', 'update')).toBe(4)
    expect(lines).toEqual(['another IP data update is running; try again when it finishes'])
  })

  it('says why a newer edition was refused when it keeps the one before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-cli-ipdata-'))
    const all = fetchAll()
    // The first country download is this month's edition; it does not parse.
    let countryFetches = 0
    const fetch: Fetcher = async (url, o) => {
      if (url.includes('country') && countryFetches++ === 0) {
        return { status: 'ok', body: gzipSync('not,a,range\n') }
      }
      return all(url, o)
    }
    lines.length = 0
    expect(await ip(dir, fetch, 'ipdata', 'update')).toBe(0)
    expect(lines.join('\n')).toMatch(/^country: updated \S+; \S+ refused: .+$/m)
  })
})
