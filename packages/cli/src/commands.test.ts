import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { type Fetcher, SOURCES, SOURCE_IDS } from '@clickmonk/ipdata'
import type { DomainResolver } from '@clickmonk/worker/domains'
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

  it('adds a domain unverified, normalised, and prints the record to publish', async () => {
    lines.length = 0
    expect(
      await run('domain', 'add', 'Go.Example.TEST.', '--root-url', 'https://example.com/'),
    ).toBe(0)
    const r = await pg.query<{ host: string; verified: boolean; verification_token: string }>(
      'SELECT host, verified, root_url, verification_token FROM domains',
    )
    expect(r.rows).toEqual([
      {
        host: 'go.example.test',
        verified: false,
        root_url: 'https://example.com/',
        verification_token: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ])
    const out = lines.join('\n')
    expect(out).toMatch(/^domain go\.example\.test [0-9a-f-]{36}$/m)
    expect(out).toContain(
      `_clickmonk.go.example.test  TXT  "clickmonk-verify=${r.rows[0]?.verification_token}"`,
    )
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

describe('clickmonk settings', () => {
  const settings = async () =>
    (await pg.query('SELECT traffic_actions, safe_url, abuser_threshold FROM settings')).rows[0]

  it('shows the defaults', async () => {
    lines.length = 0
    expect(await run('settings', 'show')).toBe(0)
    expect(lines).toEqual([
      'bot: flag',
      'abuser: flag',
      'anonymous: flag',
      'datacenter: flag',
      'safe url: (none)',
      'abuser threshold: 60 clicks a minute from one address',
    ])
  })

  it('changes only what it is given', async () => {
    expect(
      await run(
        'settings',
        'set',
        '--action',
        'bot=block',
        '--action',
        'datacenter=safe',
        '--safe-url',
        'https://example.com/safe?c={click_id}',
        '--abuser-threshold',
        '30',
      ),
    ).toBe(0)
    expect(await settings()).toEqual({
      traffic_actions: { bot: 'block', abuser: 'flag', anonymous: 'flag', datacenter: 'safe' },
      safe_url: 'https://example.com/safe?c={click_id}',
      abuser_threshold: 30,
    })
    expect(await run('settings', 'set', '--action', 'bot=flag')).toBe(0)
    expect(await settings()).toMatchObject({
      traffic_actions: { bot: 'flag', datacenter: 'safe' },
      abuser_threshold: 30,
    })
  })

  it('refuses to leave the safe action without a safe URL, and writes nothing', async () => {
    const before = await settings()
    expect(await run('settings', 'set', '--no-safe-url')).toBe(2)
    expect(await settings()).toEqual(before)
  })

  it.each([
    ['a malformed pair', ['--action', 'bot']],
    ['an unknown class', ['--action', 'human=block']],
    ['an unknown action', ['--action', 'bot=drop']],
    ['a threshold out of range', ['--abuser-threshold', '0']],
    ['both safe URL flags', ['--safe-url', 'https://example.com/', '--no-safe-url']],
  ])('refuses %s', async (_label, args) => {
    const before = await settings()
    expect(await run('settings', 'set', ...args)).toBe(2)
    expect(await settings()).toEqual(before)
  })

  it('shows the defaults, and says why, when core refuses the stored row', async () => {
    // The database check allows a token in the safe URL's host; core does not.
    await pg.query(
      `UPDATE settings SET traffic_actions = '{"bot":"block","abuser":"flag","anonymous":"flag","datacenter":"flag"}',
                           safe_url = 'https://{click_id}.example.com/'`,
    )
    lines.length = 0
    expect(await run('settings', 'show')).toBe(0)
    expect(lines[0]).toMatch(
      /^note: the stored settings are invalid \(safeUrl: .+\); the defaults apply$/,
    )
    expect(lines.slice(1)).toEqual([
      'bot: flag',
      'abuser: flag',
      'anonymous: flag',
      'datacenter: flag',
      'safe url: (none)',
      'abuser threshold: 60 clicks a minute from one address',
    ])
  })

  it('shows the defaults, and says so, when the settings row is missing', async () => {
    await pg.query('DELETE FROM settings')
    lines.length = 0
    expect(await run('settings', 'show')).toBe(0)
    expect(lines).toEqual([
      'note: no settings are stored; the defaults apply',
      'bot: flag',
      'abuser: flag',
      'anonymous: flag',
      'datacenter: flag',
      'safe url: (none)',
      'abuser threshold: 60 clicks a minute from one address',
    ])
  })

  it('writes the row back when it is missing, starting from the defaults', async () => {
    await pg.query('DELETE FROM settings')
    expect(await run('settings', 'set', '--action', 'bot=block')).toBe(0)
    expect(await settings()).toEqual({
      traffic_actions: { bot: 'block', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' },
      safe_url: null,
      abuser_threshold: 60,
    })
  })

  it('stores a link override', async () => {
    lines.length = 0
    expect(
      await run(
        'link',
        'add',
        'go.example.test',
        'guarded',
        '--target',
        'https://example.com/',
        '--action',
        'datacenter=block',
      ),
    ).toBe(0)
    const r = await pg.query("SELECT traffic_actions FROM links WHERE slug = 'guarded'")
    expect(r.rows[0]?.traffic_actions).toEqual({ datacenter: 'block' })
    expect(lines.some((l) => l.startsWith('note:'))).toBe(false)
    expect(
      await run(
        'link',
        'add',
        'go.example.test',
        'bad-override',
        '--target',
        'https://example.com/',
        '--action',
        'human=block',
      ),
    ).toBe(2)
  })

  it('stores a safe override without a safe URL, and says it will flag until one is set', async () => {
    await pg.query('UPDATE settings SET safe_url = NULL')
    lines.length = 0
    expect(
      await run(
        'link',
        'add',
        'go.example.test',
        'safe-unset',
        '--target',
        'https://example.com/',
        '--action',
        'bot=safe',
        '--action',
        'datacenter=safe',
      ),
    ).toBe(0)
    const r = await pg.query("SELECT traffic_actions FROM links WHERE slug = 'safe-unset'")
    expect(r.rows[0]?.traffic_actions).toEqual({ bot: 'safe', datacenter: 'safe' })
    expect(lines.slice(1)).toEqual([
      'note: bot, datacenter set to safe, but no safe URL is set, so those clicks are flagged until one is (clickmonk settings set --safe-url <url>)',
    ])
  })

  it('says nothing more for a safe override when a safe URL is set', async () => {
    expect(await run('settings', 'set', '--safe-url', 'https://example.com/safe')).toBe(0)
    lines.length = 0
    expect(
      await run(
        'link',
        'add',
        'go.example.test',
        'safe-set',
        '--target',
        'https://example.com/',
        '--action',
        'bot=safe',
      ),
    ).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^link go\.example\.test\/safe-set /)
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

/** Answers from a table; nothing here touches DNS. */
function fakeResolver(txt: Record<string, string[][]>): DomainResolver {
  const absent = (code: string) => Object.assign(new Error(code), { code })
  return {
    async resolveTxt(name: string) {
      const a = txt[name]
      if (a === undefined) throw absent('ENOTFOUND')
      return a
    },
    async resolve4() {
      throw absent('ENODATA')
    },
    async resolve6() {
      throw absent('ENODATA')
    },
    cancel() {},
  }
}

describe('clickmonk domain list and verify', () => {
  const withResolver = (resolver: DomainResolver, ...argv: string[]) =>
    runCli(argv, {
      pg,
      ch: () => ch,
      out: (s) => lines.push(s),
      ipdata: { dir: ipdataDir },
      resolver,
    })

  it('adds a verified domain when told to, without asking DNS anything', async () => {
    lines.length = 0
    expect(await run('domain', 'add', 'trial.example.test', '--verified')).toBe(0)
    const r = await pg.query<{ verified: boolean }>(
      'SELECT verified FROM domains WHERE host = $1',
      ['trial.example.test'],
    )
    expect(r.rows[0]?.verified).toBe(true)
    expect(lines.join('\n')).toContain('marked verified without a DNS check')
  })

  it('verifies a domain whose token is published, and exits 0', async () => {
    lines.length = 0
    expect(await run('domain', 'add', 'v.example.test')).toBe(0)
    const r = await pg.query<{ verification_token: string }>(
      'SELECT verification_token FROM domains WHERE host = $1',
      ['v.example.test'],
    )
    const token = r.rows[0]?.verification_token as string
    lines.length = 0
    expect(
      await withResolver(
        fakeResolver({ '_clickmonk.v.example.test': [[`clickmonk-verify=${token}`]] }),
        'domain',
        'verify',
        'v.example.test',
      ),
    ).toBe(0)
    expect(lines.join('\n')).toContain('v.example.test: verified')
    const after = await pg.query<{ verified: boolean }>(
      'SELECT verified FROM domains WHERE host = $1',
      ['v.example.test'],
    )
    expect(after.rows[0]?.verified).toBe(true)
  })

  it('exits 5 and reprints the record when the token is not published', async () => {
    expect(await run('domain', 'add', 'nv.example.test')).toBe(0)
    lines.length = 0
    expect(await withResolver(fakeResolver({}), 'domain', 'verify', 'nv.example.test')).toBe(5)
    const out = lines.join('\n')
    expect(out).toContain('nv.example.test: missing_token')
    expect(out).toContain('_clickmonk.nv.example.test  TXT')
    const after = await pg.query<{ verified: boolean }>(
      'SELECT verified FROM domains WHERE host = $1',
      ['nv.example.test'],
    )
    expect(after.rows[0]?.verified).toBe(false)
  })

  it('rejects verifying a domain that was never added', async () => {
    expect(await withResolver(fakeResolver({}), 'domain', 'verify', 'nope.example.test')).toBe(2)
  })

  it('lists each domain with its state and, when unverified, the record to publish', async () => {
    lines.length = 0
    expect(await run('domain', 'list')).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('trial.example.test: verified')
    expect(out).toContain('nv.example.test: unverified')
    expect(out).toContain('_clickmonk.nv.example.test TXT')
  })
})
