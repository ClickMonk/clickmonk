import { parseArgs } from 'node:util'
import {
  DEFAULT_TRAFFIC_SETTINGS,
  NON_HUMAN_CLASSES,
  type TrafficActions,
  type TrafficSettings,
  TrafficSettingsSchema,
  isDomainUrl,
  normaliseHost,
  parseLinkInput,
} from '@clickmonk/core'
import { type ClickHouseClient, type Pool, migrateToLatest } from '@clickmonk/db'
import {
  type Fetcher,
  SOURCES,
  SOURCE_IDS,
  type SourceDef,
  readManifest,
  runUpdate,
} from '@clickmonk/ipdata'
import type { ZodError } from 'zod'

export interface CliDeps {
  pg: Pool
  /** Called only by `migrate`: the other commands need no ClickHouse configuration. */
  ch: () => ClickHouseClient
  out: (s: string) => void
  /** Where the IP data lives; `fetch` and `sources` are seams for tests. */
  ipdata: { dir: string; fetch?: Fetcher; sources?: SourceDef[] }
}

const USAGE = `usage:
  clickmonk migrate
  clickmonk domain add <host> [--root-url <url>] [--not-found-url <url>]
  clickmonk link add <host> <slug> --target [<weight>=]<url> ... [--backup <url>]
                     [--cap <n>] [--expires <iso-8601>] [--no-passthrough]
                     [--action <class>=<action> ...]
  clickmonk settings show
  clickmonk settings set [--action <class>=<action> ...] [--safe-url <url> | --no-safe-url]
                         [--abuser-threshold <n>]
  clickmonk ipdata update
  clickmonk ipdata status`

class Rejected extends Error {}

/**
 * `bot=block` pairs into an object. Unknown classes and actions are left in
 * for the core schema to reject, so the message names the field.
 */
function parseActions(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const m = /^([a-z]+)=([a-z]+)$/.exec(p)
    if (!m) throw new Rejected(`--action takes <class>=<action>, such as bot=block: ${p}`)
    out[m[1] as string] = m[2] as string
  }
  return out
}

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
    // Sent as written, so no token: `{click_id}` would reach the visitor literally.
    if (u !== undefined && !isDomainUrl(u))
      throw new Rejected(`not an http(s) URL in printable ASCII without tokens: ${u}`)
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
      action: { type: 'string', multiple: true },
    },
  })
  const host = normaliseHost(positionals[0] ?? '')
  if (!host) throw new Rejected(`not a valid host name: ${positionals[0] ?? '(none)'}`)

  const input = parseLinkInput({
    trafficActions: parseActions(values.action),
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
                          countries, click_cap, expires_at, passthrough, traffic_actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        JSON.stringify(input.trafficActions),
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

function printSettings(s: TrafficSettings, d: CliDeps): void {
  for (const c of NON_HUMAN_CLASSES) d.out(`${c}: ${s.actions[c]}`)
  d.out(`safe url: ${s.safeUrl ?? '(none)'}`)
  d.out(`abuser threshold: ${s.abuserThreshold} clicks a minute from one address`)
}

interface SettingsRow {
  traffic_actions: TrafficActions
  safe_url: string | null
  abuser_threshold: number
}

const toSettings = (r: SettingsRow): TrafficSettings => ({
  actions: r.traffic_actions,
  safeUrl: r.safe_url,
  abuserThreshold: r.abuser_threshold,
})

/**
 * Shows what the redirect serves: a row that is missing (deleted by hand) or
 * that core's schema refuses means the defaults there, so it does here too.
 */
async function settingsShow(d: CliDeps): Promise<void> {
  const r = await d.pg.query<SettingsRow>(
    'SELECT traffic_actions, safe_url, abuser_threshold FROM settings',
  )
  const row = r.rows[0]
  if (!row) {
    d.out('note: no settings are stored; the defaults apply')
    printSettings(DEFAULT_TRAFFIC_SETTINGS, d)
    return
  }
  const parsed = TrafficSettingsSchema.safeParse(toSettings(row))
  if (parsed.success) {
    printSettings(parsed.data, d)
    return
  }
  const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  d.out(`note: the stored settings are invalid (${why}); the defaults apply`)
  printSettings(DEFAULT_TRAFFIC_SETTINGS, d)
}

/**
 * Changes only what is given; the result is validated whole before anything
 * is written. A row deleted by hand is first written back as the defaults,
 * in the same transaction, so that concurrent writers still serialise on its
 * lock.
 */
async function settingsSet(args: string[], d: CliDeps): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      action: { type: 'string', multiple: true },
      'safe-url': { type: 'string' },
      'no-safe-url': { type: 'boolean' },
      'abuser-threshold': { type: 'string' },
    },
  })
  if (values['safe-url'] !== undefined && values['no-safe-url']) {
    throw new Rejected('--safe-url and --no-safe-url together')
  }
  const client = await d.pg.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING')
    const r = await client.query<SettingsRow>(
      'SELECT traffic_actions, safe_url, abuser_threshold FROM settings FOR UPDATE',
    )
    const row = r.rows[0]
    if (!row) throw new Error('the settings row is missing after writing it')
    const current = toSettings(row)
    const next = TrafficSettingsSchema.parse({
      actions: { ...current.actions, ...parseActions(values.action) },
      safeUrl: values['no-safe-url'] ? null : (values['safe-url'] ?? current.safeUrl),
      abuserThreshold:
        values['abuser-threshold'] === undefined
          ? current.abuserThreshold
          : Number(values['abuser-threshold']),
    })
    await client.query(
      `UPDATE settings SET traffic_actions = $1, safe_url = $2, abuser_threshold = $3,
                           updated_at = now()`,
      [JSON.stringify(next.actions), next.safeUrl, next.abuserThreshold],
    )
    await client.query('COMMIT')
    printSettings(next, d)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Downloads every IP data source now, however recently it was fetched, and
 * installs what passes validation. The worker does the same on a schedule.
 */
async function ipdataUpdate(d: CliDeps): Promise<boolean> {
  const r = await runUpdate({
    dir: d.ipdata.dir,
    force: true,
    ...(d.ipdata.fetch ? { fetch: d.ipdata.fetch } : {}),
    ...(d.ipdata.sources ? { sources: d.ipdata.sources } : {}),
  })
  if (r === 'busy') {
    d.out('another IP data update is running; try again when it finishes')
    return false
  }
  for (const s of r) {
    d.out(
      `${s.id}: ${s.outcome}${s.version ? ` ${s.version}` : ''}${s.error ? ` (${s.error})` : ''}${s.refused ? `; ${s.refused}` : ''}`,
    )
  }
  return r.every((s) => s.outcome !== 'failed')
}

function ipdataStatus(d: CliDeps): void {
  const m = readManifest(d.ipdata.dir)
  for (const id of SOURCE_IDS) {
    const e = m?.sources[id]
    const name = SOURCES[id].name
    d.out(
      e
        ? `${id}: ${name} ${e.version}, fetched ${e.fetchedAt}, ${e.entries.k32} + ${e.entries.k128} entries`
        : `${id}: ${name}, not downloaded yet`,
    )
  }
  // One line per attribution: the two DB-IP editions share theirs.
  const attributions = new Set(
    SOURCE_IDS.filter((id) => m?.sources[id]).map((id) => SOURCES[id].attribution),
  )
  if (attributions.size > 0) d.out('')
  for (const a of attributions) d.out(a)
}

/** Returns the process exit code: 0 ok, 1 usage, 2 rejected input, 4 an IP data source failed to update. */
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
    if (cmd === 'settings' && sub === 'show' && rest.length === 0) {
      await settingsShow(d)
      return 0
    }
    if (cmd === 'settings' && sub === 'set') {
      await settingsSet(rest, d)
      return 0
    }
    if (cmd === 'ipdata' && sub === 'update' && rest.length === 0) {
      return (await ipdataUpdate(d)) ? 0 : 4
    }
    if (cmd === 'ipdata' && sub === 'status' && rest.length === 0) {
      ipdataStatus(d)
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
