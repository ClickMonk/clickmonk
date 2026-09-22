import { parseArgs } from 'node:util'
import { isDestinationUrl, normaliseHost, parseLinkInput } from '@clickmonk/core'
import { type ClickHouseClient, type Pool, migrateToLatest } from '@clickmonk/db'
import type { ZodError } from 'zod'

export interface CliDeps {
  pg: Pool
  /** Called only by `migrate`: the other commands need no ClickHouse configuration. */
  ch: () => ClickHouseClient
  out: (s: string) => void
}

const USAGE = `usage:
  clickmonk migrate
  clickmonk domain add <host> [--root-url <url>] [--not-found-url <url>]
  clickmonk link add <host> <slug> --target [<weight>=]<url> ... [--backup <url>]
                     [--cap <n>] [--expires <iso-8601>] [--no-passthrough]`

class Rejected extends Error {}

/** `70=https://x/` -> weight 70; `https://x/?a=1` -> no weight. A URL starts with its scheme, so a leading `<digits>=` is unambiguous. */
function splitTarget(s: string): { url: string; weight?: number } {
  const m = /^(\d{1,3})=(https?:\/\/.*)$/i.exec(s)
  return m ? { url: m[2] as string, weight: Number(m[1]) } : { url: s }
}

async function domainAdd(args: string[], d: CliDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'root-url': { type: 'string' }, 'not-found-url': { type: 'string' } },
  })
  const host = normaliseHost(positionals[0] ?? '')
  if (!host) throw new Rejected(`not a valid host name: ${positionals[0] ?? '(none)'}`)
  for (const u of [values['root-url'], values['not-found-url']]) {
    if (u !== undefined && !isDestinationUrl(u)) throw new Rejected(`not an http(s) URL: ${u}`)
  }
  const r = await d.pg.query<{ id: string }>(
    `INSERT INTO domains (host, verified, root_url, not_found_url) VALUES ($1, true, $2, $3)
     ON CONFLICT (host) DO NOTHING RETURNING id`,
    [host, values['root-url'] ?? null, values['not-found-url'] ?? null],
  )
  const id = r.rows[0]?.id
  if (!id) throw new Rejected(`domain already exists: ${host}`)
  d.out(`domain ${host} ${id}`)
  d.out('note: marked verified without a DNS check; DNS verification is not built yet')
}

async function linkAdd(args: string[], d: CliDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: 'string', multiple: true },
      backup: { type: 'string' },
      cap: { type: 'string' },
      expires: { type: 'string' },
      'no-passthrough': { type: 'boolean' },
    },
  })
  const host = normaliseHost(positionals[0] ?? '')
  if (!host) throw new Rejected(`not a valid host name: ${positionals[0] ?? '(none)'}`)

  const input = parseLinkInput({
    slug: positionals[1] ?? '',
    targets: (values.target ?? []).map(splitTarget),
    backupUrl: values.backup ?? null,
    clickCap: values.cap === undefined ? null : Number(values.cap),
    expiresAt: values.expires ?? null,
    passthrough: !values['no-passthrough'],
  })

  const client = await d.pg.connect()
  try {
    await client.query('BEGIN')
    const dom = await client.query<{ id: string }>('SELECT id FROM domains WHERE host = $1', [host])
    const domainId = dom.rows[0]?.id
    if (!domainId)
      throw new Rejected(`unknown domain: ${host} (add it with "clickmonk domain add")`)
    const l = await client.query<{ id: string }>(
      `INSERT INTO links (domain_id, slug, name, enabled, backup_url, device_urls, returning_url,
                          countries, click_cap, expires_at, passthrough)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (domain_id, slug) DO NOTHING RETURNING id`,
      [
        domainId,
        input.slug,
        input.name,
        input.enabled,
        input.backupUrl,
        JSON.stringify(input.deviceUrls),
        input.returningUrl,
        JSON.stringify(input.countries),
        input.clickCap,
        input.expiresAt,
        input.passthrough,
      ],
    )
    const linkId = l.rows[0]?.id
    if (!linkId) throw new Rejected(`slug already exists on ${host}: ${input.slug}`)
    for (const [i, t] of input.targets.entries()) {
      await client.query(
        'INSERT INTO link_targets (link_id, url, weight, position) VALUES ($1, $2, $3, $4)',
        [linkId, t.url, t.weight, i],
      )
    }
    await client.query('COMMIT')
    d.out(`link ${host}/${input.slug} ${linkId}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Returns the process exit code: 0 ok, 1 usage, 2 rejected input. */
export async function runCli(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, sub, ...rest] = argv
  try {
    if (cmd === 'migrate' && sub === undefined) {
      const { applied } = await migrateToLatest(d.pg, d.ch())
      d.out(applied.length ? `applied ${applied.join(', ')}` : 'up to date')
      return 0
    }
    if (cmd === 'domain' && sub === 'add') {
      await domainAdd(rest, d)
      return 0
    }
    if (cmd === 'link' && sub === 'add') {
      await linkAdd(rest, d)
      return 0
    }
    d.out(USAGE)
    return 1
  } catch (err) {
    if (err instanceof Rejected) {
      d.out(`error: ${err.message}`)
      return 2
    }
    // By name, not instanceof: the ZodError comes from core's copy of zod.
    if (err instanceof Error && err.name === 'ZodError') {
      d.out(
        `error: ${(err as ZodError).issues.map((i) => `${i.path.join('.') || 'link'}: ${i.message}`).join('; ')}`,
      )
      return 2
    }
    if (
      err instanceof TypeError &&
      'code' in err &&
      String(err.code).startsWith('ERR_PARSE_ARGS')
    ) {
      d.out(`error: ${err.message}\n${USAGE}`)
      return 1
    }
    throw err
  }
}
