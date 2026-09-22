import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './commands.js'

const pg = testPg()
const ch = testCh()
const lines: string[] = []
const run = (...argv: string[]) => runCli(argv, { pg, ch: () => ch, out: (s) => lines.push(s) })

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
    })
    expect(code).toBe(0)
  })

  it('prints usage and exits 1 on an unknown command', async () => {
    lines.length = 0
    expect(await run('frobnicate')).toBe(1)
    expect(lines.join('\n')).toMatch(/usage/i)
  })
})
