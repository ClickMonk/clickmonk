import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { MAX_KEYS_LISTED, MAX_KEY_DAYS, MAX_KEY_NAME_LENGTH } from '@clickmonk/admin/keys'
import {
  ADMIN_SCRYPT,
  LINK_SCRYPT,
  SCRYPT_PREFIX,
  hashPassword,
  hashToken,
  parseApiKey,
  verifyPassword,
} from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { type Fetcher, SOURCES, SOURCE_IDS } from '@clickmonk/ipdata'
import type { DomainResolver } from '@clickmonk/worker/domains'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

  // Placed here, before any other test in the file adds a domain: the
  // database is empty only once, right after resetDatabases, and every
  // later test in this file leaves at least one domain behind.
  it('says there is nothing to verify yet, and exits 0, on a bare verify with no domains', async () => {
    lines.length = 0
    expect(await run('domain', 'verify')).toBe(0)
    expect(lines).toEqual(['no domains yet (add one with "clickmonk domain add")'])
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

  // The second add must not overwrite the first: the domain it would replace
  // may already be verified and serving.
  it('rejects a second domain with the same host, and leaves the first alone', async () => {
    expect(await run('domain', 'add', 'twice.example.test')).toBe(0)
    const first = await pg.query<{ id: string; verification_token: string }>(
      'SELECT id, verification_token FROM domains WHERE host = $1',
      ['twice.example.test'],
    )
    lines.length = 0
    expect(await run('domain', 'add', 'twice.example.test')).toBe(2)
    expect(lines).toEqual(['error: domain already exists: twice.example.test'])
    const after = await pg.query<{ id: string; verification_token: string }>(
      'SELECT id, verification_token FROM domains WHERE host = $1',
      ['twice.example.test'],
    )
    expect(after.rows).toEqual(first.rows)
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

/**
 * Answers from a table; nothing here touches DNS. Counts what it was asked
 * and how many times it was cancelled, so a test can pin that nothing asked
 * it at all, or that it was released.
 */
function fakeResolver(txt: Record<string, string[][]>): DomainResolver & {
  asked: number
  cancelled: number
} {
  const absent = (code: string) => Object.assign(new Error(code), { code })
  const r = {
    asked: 0,
    cancelled: 0,
    async resolveTxt(name: string) {
      r.asked++
      const a = txt[name]
      if (a === undefined) throw absent('ENOTFOUND')
      return a
    },
    async resolve4() {
      r.asked++
      throw absent('ENODATA')
    },
    async resolve6() {
      r.asked++
      throw absent('ENODATA')
    },
    cancel() {
      r.cancelled++
    },
  }
  return r
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
    const resolver = fakeResolver({})
    expect(await withResolver(resolver, 'domain', 'add', 'trial.example.test', '--verified')).toBe(
      0,
    )
    expect(resolver.asked).toBe(0)
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
    expect(out).toContain('answer 404')
    const after = await pg.query<{ verified: boolean }>(
      'SELECT verified FROM domains WHERE host = $1',
      ['nv.example.test'],
    )
    expect(after.rows[0]?.verified).toBe(false)
  })

  it('confirms an already-verified domain normally when its token is published too', async () => {
    expect(await run('domain', 'add', 'preverified.example.test', '--verified')).toBe(0)
    const r = await pg.query<{ verification_token: string }>(
      'SELECT verification_token FROM domains WHERE host = $1',
      ['preverified.example.test'],
    )
    const token = r.rows[0]?.verification_token as string
    lines.length = 0
    expect(
      await withResolver(
        fakeResolver({ '_clickmonk.preverified.example.test': [[`clickmonk-verify=${token}`]] }),
        'domain',
        'verify',
        'preverified.example.test',
      ),
    ).toBe(0)
    expect(lines.join('\n')).toContain('preverified.example.test: verified')
  })

  it('says an already-verified domain stays verified, and does not warn it will 404, when its token is not published', async () => {
    expect(await run('domain', 'add', 'stillok.example.test', '--verified')).toBe(0)
    lines.length = 0
    expect(await withResolver(fakeResolver({}), 'domain', 'verify', 'stillok.example.test')).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('stillok.example.test: still verified')
    expect(out).not.toContain('404')
    expect(out).toContain('_clickmonk.stillok.example.test  TXT')
    const after = await pg.query<{ verified: boolean }>(
      'SELECT verified FROM domains WHERE host = $1',
      ['stillok.example.test'],
    )
    expect(after.rows[0]?.verified).toBe(true)
  })

  it('rejects verifying a domain that was never added, and still releases the resolver', async () => {
    const resolver = fakeResolver({})
    expect(await withResolver(resolver, 'domain', 'verify', 'nope.example.test')).toBe(2)
    expect(resolver.cancelled).toBe(1)
  })

  it('refuses more than one host to verify', async () => {
    lines.length = 0
    expect(await run('domain', 'verify', 'a.example.test', 'b.example.test')).toBe(1)
    expect(lines.join('\n')).toMatch(/usage/i)
  })

  it('stamps a check with the clock it is given, the same seam the worker pass uses', async () => {
    expect(await run('domain', 'add', 'clocked.example.test')).toBe(0)
    const r = await pg.query<{ verification_token: string }>(
      'SELECT verification_token FROM domains WHERE host = $1',
      ['clocked.example.test'],
    )
    const token = r.rows[0]?.verification_token as string
    const fixed = new Date(Date.now() - 3_600_000)
    const code = await runCli(['domain', 'verify', 'clocked.example.test'], {
      pg,
      ch: () => ch,
      out: (s) => lines.push(s),
      ipdata: { dir: ipdataDir },
      resolver: fakeResolver({
        '_clickmonk.clocked.example.test': [[`clickmonk-verify=${token}`]],
      }),
      now: () => fixed,
    })
    expect(code).toBe(0)
    const check = await pg.query<{ checked_at: Date }>(
      `SELECT checked_at FROM domain_dns_checks c
        JOIN domains d ON d.id = c.domain_id WHERE d.host = $1`,
      ['clocked.example.test'],
    )
    expect(check.rows[0]?.checked_at.getTime()).toBe(fixed.getTime())
  })

  it('checks every domain in one bare pass, not just the worker’s own default batch of 50', async () => {
    await pg.query(
      `INSERT INTO domains (host, verified, verification_token)
       SELECT 'bulk' || i || '.example.test', false, replace(gen_random_uuid()::text, '-', '')
         FROM generate_series(1, 55) AS i`,
    )
    lines.length = 0
    expect(await withResolver(fakeResolver({}), 'domain', 'verify')).toBe(5)
    const summary = lines.find((l) => l.startsWith('domain check: checked '))
    const checked = Number(/checked (\d+)/.exec(summary ?? '')?.[1])
    expect(checked).toBeGreaterThan(50)
  })

  it('lists each domain with its state, its A/AAAA reminder and, when unverified, the record to publish', async () => {
    lines.length = 0
    expect(await run('domain', 'list')).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('trial.example.test: verified')
    expect(out).toContain('nv.example.test: unverified')
    expect(out).toContain('_clickmonk.nv.example.test  TXT')
    expect(out).toContain('point nv.example.test at this server with an A or AAAA record')
  })
})

describe('the admin account and API keys from the CLI', () => {
  /** The moment the clock reads for every command below, so an expiry is exact. */
  const NOW = new Date('2026-09-23T10:00:00.000Z')

  /** The CLI with a password on standard input, which is the only way it takes one. */
  const withPassword = (password: string, ...argv: string[]) =>
    runCli(argv, {
      pg,
      ch: () => ch,
      out: (s) => lines.push(s),
      ipdata: { dir: ipdataDir },
      stdin: async () => password,
      now: () => NOW,
    })

  /** The same, at a later moment: what an operator sees once a key has run out. */
  const later = (days: number, ...argv: string[]) =>
    runCli(argv, {
      pg,
      ch: () => ch,
      out: (s) => lines.push(s),
      ipdata: { dir: ipdataDir },
      now: () => new Date(NOW.getTime() + days * 86_400_000),
    })

  const account = () =>
    pg.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM admin_account',
    )

  /**
   * A stored hash for the account the key tests need, derived here rather than
   * written out, and at the link cost because nothing below verifies against
   * it: this is the cheapest thing that satisfies the column's own check.
   */
  let storedHash = ''
  beforeAll(async () => {
    storedHash = await hashPassword('nothing below verifies against this', LINK_SCRYPT)
  })

  /**
   * An API key references the account row, so a key cannot exist without one.
   * Written straight in: `admin create` has its own tests, and going through it
   * here would cost every key test a scrypt pass at the admin's cost.
   */
  const anAccount = () =>
    pg.query('INSERT INTO admin_account (email, password_hash) VALUES ($1, $2)', [
      'admin@example.com',
      storedHash,
    ])

  beforeEach(async () => {
    lines.length = 0
    await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  })

  it('creates the one admin account, and says what to set next', async () => {
    expect(
      await withPassword('a decent admin password', 'admin', 'create', 'Admin@Example.com'),
    ).toBe(0)
    const r = await account()
    expect(r.rows[0]?.email).toBe('admin@example.com')
    // The frame and the admin's cost, built from the constants rather than
    // written out: no `scrypt$…` literal is committed anywhere in this tree.
    expect(r.rows[0]?.password_hash.startsWith(`${SCRYPT_PREFIX}$${ADMIN_SCRYPT.N}$`)).toBe(true)
    const out = lines.join('\n')
    expect(out).toContain('admin admin@example.com created')
    expect(out).toContain('CLICKMONK_ADMIN_HOST')
    // The password is never printed, whatever else is.
    expect(out).not.toContain('a decent admin password')
  })

  // Ordered so that each refusal is the only thing that could have produced
  // it: the floor and the address are tried while there is no account, because
  // once one exists a second `admin create` is refused whatever the password
  // or the address was, and a test run in that order passes with the floor
  // taken out.
  it('refuses a short password, an address that is not one, and a second account', async () => {
    expect(await withPassword('short', 'admin', 'create', 'admin@example.com')).toBe(2)
    expect(lines.join('\n')).toContain('at least 12 characters')
    // Neither the password nor its length is echoed back.
    expect(lines.join('\n')).not.toContain('short')
    expect((await account()).rowCount).toBe(0)

    lines.length = 0
    expect(await withPassword('a decent admin password', 'admin', 'create', 'not-an-address')).toBe(
      2,
    )
    expect(lines.join('\n')).toContain('not an email address')
    expect((await account()).rowCount).toBe(0)

    expect(
      await withPassword('a decent admin password', 'admin', 'create', 'admin@example.com'),
    ).toBe(0)
    const first = await account()
    lines.length = 0
    expect(
      await withPassword('another decent password', 'admin', 'create', 'other@example.com'),
    ).toBe(2)
    expect(lines.join('\n')).toContain('already has an admin account')
    // The refusal is not enough on its own: the account it would have replaced
    // may be the only way into this install, so the row is read back whole.
    expect((await account()).rows).toEqual(first.rows)
  })

  it('takes a password with a trailing newline, as a shell pipe sends one', async () => {
    expect(
      await withPassword('a decent admin password\n', 'admin', 'create', 'admin@example.com'),
    ).toBe(0)
    const r = await account()
    expect(
      await verifyPassword('a decent admin password', r.rows[0]?.password_hash as string),
    ).toBe(true)
    // And the newline is not part of it, so the two spellings are one password.
    expect(
      await verifyPassword('a decent admin password\n', r.rows[0]?.password_hash as string),
    ).toBe(false)
  })

  it('changes the password and signs every browser out', async () => {
    await withPassword('a decent admin password', 'admin', 'create', 'admin@example.com')
    const before = (await account()).rows[0]?.password_hash as string
    await pg.query(
      "INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + interval '1 day')",
      ['a'.repeat(64)],
    )
    lines.length = 0
    expect(await withPassword('a new decent password', 'admin', 'passwd')).toBe(0)
    expect(lines.join('\n')).toContain('1 session(s) signed out')
    expect((await pg.query('SELECT 1 FROM sessions')).rowCount).toBe(0)
    const after = (await account()).rows[0]?.password_hash as string
    expect(after).not.toBe(before)
    expect(await verifyPassword('a new decent password', after)).toBe(true)
  })

  // The lockout is cleared with the password because this command is the way
  // back in: an admin locked out at the form sets a new one and uses it at
  // once, rather than waiting out a lock on a password that no longer exists.
  it('clears a standing lockout, so the new password works at once', async () => {
    await withPassword('a decent admin password', 'admin', 'create', 'admin@example.com')
    await pg.query(
      `UPDATE admin_account SET failed_logins = 9, last_failed_at = now(),
                                locked_until = now() + interval '1 hour'`,
    )
    expect(await withPassword('a new decent password', 'admin', 'passwd')).toBe(0)
    const r = await pg.query<{
      failed_logins: number
      last_failed_at: Date | null
      locked_until: Date | null
    }>('SELECT failed_logins, last_failed_at, locked_until FROM admin_account')
    expect(r.rows[0]).toEqual({ failed_logins: 0, last_failed_at: null, locked_until: null })
  })

  it('mints an API key, shows it once, and stores only its digest', async () => {
    await anAccount()
    expect(await withPassword('', 'apikey', 'create', 'reporting', '--expires-days', '7')).toBe(0)
    const key = lines[0] as string
    expect(key).toMatch(/^cmk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/)
    // Split by the parser the authentication path itself uses. A key's secret
    // is base64url, so it may contain an underscore of its own, and taking the
    // third `_`-separated field truncates roughly one key in three.
    const secret = (parseApiKey(key) as { secret: string }).secret
    const r = await pg.query<{ secret_hash: string; expires_at: Date }>(
      'SELECT secret_hash, expires_at FROM api_keys',
    )
    expect(r.rows[0]?.secret_hash).toBe(hashToken(secret))
    // Not merely "hashed": the secret itself is nowhere in the row.
    expect(r.rows[0]?.secret_hash).not.toContain(secret)
    expect(r.rows[0]?.expires_at.toISOString()).toBe('2026-09-30T10:00:00.000Z')
    expect(lines.join('\n')).toContain('only time this key is shown')
  })

  // 3651 and 0 are written out. Derived from the constant, these would move
  // with a raised bound and pass against a command that had lost the check.
  it('refuses a life that is not a whole number of days inside the bound', async () => {
    await anAccount()
    expect(MAX_KEY_DAYS).toBe(3650)
    // No '-1' here: a leading dash is an option to the argument parser, which
    // refuses it as a usage error before this bound is reached.
    for (const days of ['3651', '0', '7.5', 'soon', '']) {
      lines.length = 0
      expect(await withPassword('', 'apikey', 'create', 'reporting', '--expires-days', days)).toBe(
        2,
      )
      expect(lines.join('\n'), days).toContain('--expires-days takes a whole number of days')
    }
    expect((await pg.query('SELECT 1 FROM api_keys')).rowCount).toBe(0)
    // The bound itself is a life a key may have.
    expect(await withPassword('', 'apikey', 'create', 'reporting', '--expires-days', '3650')).toBe(
      0,
    )
  })

  it('refuses a key with no name, and one longer than the column takes', async () => {
    await anAccount()
    expect(MAX_KEY_NAME_LENGTH).toBe(100)
    expect(await withPassword('', 'apikey', 'create')).toBe(2)
    expect(await withPassword('', 'apikey', 'create', 'x'.repeat(101))).toBe(2)
    expect((await pg.query('SELECT 1 FROM api_keys')).rowCount).toBe(0)
    expect(await withPassword('', 'apikey', 'create', 'x'.repeat(100))).toBe(0)
  })

  it('lists keys without their secrets, and revokes one', async () => {
    await anAccount()
    expect(await withPassword('', 'apikey', 'create', 'reporting')).toBe(0)
    const parsed = parseApiKey(lines[0] as string) as { id: string; secret: string }
    const { id, secret } = parsed
    lines.length = 0
    expect(await withPassword('', 'apikey', 'list')).toBe(0)
    // The whole line, so a secret could not hide at the end of it.
    expect(lines).toEqual([`${id}  reporting: active; never used`])
    expect(lines.join('\n')).not.toContain(secret)

    lines.length = 0
    expect(await withPassword('', 'apikey', 'revoke', id)).toBe(0)
    const revoked = await pg.query<{ revoked_at: Date }>('SELECT revoked_at FROM api_keys')
    expect(revoked.rows[0]?.revoked_at.toISOString()).toBe(NOW.toISOString())

    lines.length = 0
    expect(await withPassword('', 'apikey', 'revoke', id)).toBe(2)
    expect(lines.join('\n')).toContain('already revoked')
    // Revoking twice leaves the first time it happened, which is the record of
    // when the key actually stopped working.
    expect((await pg.query<{ revoked_at: Date }>('SELECT revoked_at FROM api_keys')).rows).toEqual(
      revoked.rows,
    )

    lines.length = 0
    expect(await withPassword('', 'apikey', 'revoke', 'nope')).toBe(2)
    expect(lines.join('\n')).toContain('not a key id')

    lines.length = 0
    expect(await withPassword('', 'apikey', 'list')).toBe(0)
    expect(lines).toEqual([`${id}  reporting: revoked ${NOW.toISOString()}; never used`])
  })

  // A key past its expiry is dead, and a listing that called it active would
  // have an operator hunting for why a script stopped working.
  it('says a key has run out rather than calling it active', async () => {
    await anAccount()
    expect(await withPassword('', 'apikey', 'create', 'reporting', '--expires-days', '7')).toBe(0)
    const { id } = parseApiKey(lines[0] as string) as { id: string }
    lines.length = 0
    expect(await later(8, 'apikey', 'list')).toBe(0)
    expect(lines).toEqual([`${id}  reporting: expired 2026-09-30T10:00:00.000Z; never used`])
  })

  it('says so when there are no keys', async () => {
    expect(await withPassword('', 'apikey', 'list')).toBe(0)
    expect(lines).toEqual(['no API keys yet (make one with "clickmonk apikey create <name>")'])
  })

  // A listing that stopped at the cap is a prefix, and an operator managing
  // the wrong set would never find out. Rows go straight in: minting 201 keys
  // would be 201 digests for nothing.
  it('says when the listing was cut', async () => {
    await anAccount()
    expect(MAX_KEYS_LISTED).toBe(200)
    await pg.query(
      `INSERT INTO api_keys (id, name, secret_hash)
       SELECT lpad(to_hex(n), 16, '0'), 'bulk-' || n, repeat('b', 64)
         FROM generate_series(1, 200) AS n`,
    )
    expect(await withPassword('', 'apikey', 'list')).toBe(0)
    expect(lines).toHaveLength(200)
    expect(lines.at(-1)).not.toBe('(more keys than this list shows; revoke some)')
    lines.length = 0
    await pg.query(
      "INSERT INTO api_keys (id, name, secret_hash) VALUES ('ffffffffffffffff', 'one more', repeat('b', 64))",
    )
    expect(await withPassword('', 'apikey', 'list')).toBe(0)
    expect(lines).toHaveLength(201)
    expect(lines.at(-1)).toBe('(more keys than this list shows; revoke some)')
  })

  it('names the new commands in its usage', async () => {
    expect(await run('admin')).toBe(1)
    expect(lines.join('\n')).toContain('clickmonk admin create <email>')
    expect(lines.join('\n')).toContain('clickmonk apikey create <name>')
  })
})
