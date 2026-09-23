import { parseArgs } from 'node:util'
import {
  DEFAULT_TRAFFIC_SETTINGS,
  NON_HUMAN_CLASSES,
  type TrafficActions,
  type TrafficSettings,
  TrafficSettingsSchema,
  isDomainUrl,
  newVerificationToken,
  normaliseHost,
  parseLinkInput,
  verificationRecordName,
  verificationRecordValue,
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
import {
  type DomainResolver,
  checkDomain,
  createResolver,
  recordDomainCheck,
  runDomainChecks,
} from '@clickmonk/worker/domains'
import type { ZodError } from 'zod'

export interface CliDeps {
  pg: Pool
  /** Called only by `migrate`: the other commands need no ClickHouse configuration. */
  ch: () => ClickHouseClient
  out: (s: string) => void
  /** Where the IP data lives; `fetch` and `sources` are seams for tests. */
  ipdata: { dir: string; fetch?: Fetcher; sources?: SourceDef[] }
  /**
   * The resolver `domain verify` asks. A test passes its own; otherwise one
   * is built from `dnsServers`. Either way, `domain verify` treats it as its
   * own for the call's duration and cancels it when done — the same
   * convention `startDomainChecker` uses for the resolver it is given — so a
   * caller that wants to reuse one resolver across several `domain verify`
   * calls should build a fresh one for each instead.
   */
  resolver?: DomainResolver
  /** Resolver addresses for `domain verify`; the host's own when empty. */
  dnsServers?: string[]
  /** The clock a check is stamped with, so the worker and the CLI can be made to agree in a test. */
  now?: () => Date
}

const USAGE = `usage:
  clickmonk migrate
  clickmonk domain add <host> [--root-url <url>] [--not-found-url <url>] [--verified]
  clickmonk domain list
  clickmonk domain verify [<host>]
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
    options: {
      'root-url': { type: 'string' },
      'not-found-url': { type: 'string' },
      verified: { type: 'boolean' },
    },
  })
  const host = normaliseHost(positionals[0] ?? '')
  if (!host) throw new Rejected(`not a valid host name: ${positionals[0] ?? '(none)'}`)
  for (const u of [values['root-url'], values['not-found-url']]) {
    // Sent as written, so no token: `{click_id}` would reach the visitor literally.
    if (u !== undefined && !isDomainUrl(u))
      throw new Rejected(`not an http(s) URL in printable ASCII without tokens: ${u}`)
  }
  const token = newVerificationToken()
  const verified = values.verified === true
  const r = await d.pg.query<{ id: string; verification_token: string }>(
    `INSERT INTO domains (host, verified, root_url, not_found_url, verification_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (host) DO NOTHING RETURNING id, verification_token`,
    [host, verified, values['root-url'] ?? null, values['not-found-url'] ?? null, token],
  )
  const row = r.rows[0]
  if (!row) throw new Rejected(`domain already exists: ${host}`)
  d.out(`domain ${host} ${row.id}`)
  if (verified) {
    d.out('marked verified without a DNS check, so it can be given a certificate at once')
    return
  }
  printVerificationRecords(host, row.verification_token, d)
}

/**
 * The record to publish, formatted exactly once so the standalone block
 * below and `domain list`'s per-row line can never drift into two spacings.
 */
function formatVerificationRecord(host: string, token: string): string {
  return `${verificationRecordName(host)}  TXT  "${verificationRecordValue(token)}"`
}

/**
 * What the admin has to publish, and what happens next. Printed by `domain
 * add` and `domain verify`.
 *
 * `alreadyServing` is for a domain that is already verified — marked so with
 * `--verified`, or by an earlier successful check — whose *current* check
 * did not find the token: the domain still serves and still keeps whatever
 * certificate it has, so the usual "answers 404, gets no certificate"
 * warning would be false for it.
 */
function printVerificationRecords(
  host: string,
  token: string,
  d: CliDeps,
  opts: { alreadyServing?: boolean } = {},
): void {
  d.out('')
  d.out('Publish this TXT record, then the domain is verified within a few minutes:')
  d.out(`  ${formatVerificationRecord(host, token)}`)
  d.out('')
  if (opts.alreadyServing) {
    d.out(`${host} is already verified and serves as usual; this record is only needed`)
    d.out('if it is ever reset to unverified, or to complete DNS verification for real.')
    return
  }
  d.out(`Point ${host} at this server with an A or AAAA record (or a CNAME).`)
  d.out('Until the TXT record is found, links on this domain answer 404 and it gets no')
  d.out('certificate. Check it now with:')
  d.out(`  clickmonk domain verify ${host}`)
}

interface DomainListRow {
  host: string
  verified: boolean
  verification_token: string
  status: string | null
  detail: string | null
  checked_at: Date | null
}

async function domainList(d: CliDeps): Promise<void> {
  const r = await d.pg.query<DomainListRow>(
    `SELECT d.host, d.verified, d.verification_token, c.status, c.detail, c.checked_at
       FROM domains d
       LEFT JOIN domain_dns_checks c ON c.domain_id = d.id
      ORDER BY d.host`,
  )
  if (r.rows.length === 0) {
    d.out('no domains yet (add one with "clickmonk domain add")')
    return
  }
  for (const row of r.rows) {
    const last = row.checked_at
      ? `${row.status}, checked ${row.checked_at.toISOString()}`
      : 'not checked yet'
    d.out(`${row.host}: ${row.verified ? 'verified' : 'unverified'}; ${last}`)
    if (row.detail) d.out(`  ${row.detail}`)
    if (!row.verified) {
      d.out(`  publish ${formatVerificationRecord(row.host, row.verification_token)}`)
      d.out(`  point ${row.host} at this server with an A or AAAA record (or a CNAME)`)
    }
  }
}

/**
 * Checks now rather than waiting for the worker's next pass. With a host,
 * that one domain; without, every domain currently stored, oldest check
 * first — no domains yet is not a failure. Returns false when a domain
 * checked came back not verified and was not already verified some other
 * way (`--verified`, or an earlier successful check); an already-verified
 * domain whose token this check could not find is not a regression, so it
 * does not turn this into a failure.
 */
async function domainVerify(args: string[], d: CliDeps): Promise<boolean> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const resolver = d.resolver ?? createResolver(d.dnsServers ?? [])
  // One clock for both branches, and the same seam the worker's pass takes,
  // so a check written here and one written there can never disagree about
  // what `now` was.
  const now = d.now?.() ?? new Date()
  try {
    if (positionals.length === 0) {
      const total = await d.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM domains')
      const limit = total.rows[0]?.n ?? 0
      if (limit === 0) {
        d.out('no domains yet (add one with "clickmonk domain add")')
        return true
      }
      const run = await runDomainChecks({
        pg: d.pg,
        resolver,
        now: () => now,
        // Every domain currently stored, not the worker's own default
        // batch: an operator running this by hand means to check all of
        // them, not wait several passes for the rest to come round.
        limit,
        // An operator typed this command, so every domain gets a line, not
        // only the ones whose status changed since the last check. The
        // worker's own pass leaves this off and logs transitions.
        logEvery: true,
        log: (m) => d.out(m),
      })
      return run.failed === 0 && run.checked > 0
    }
    const host = normaliseHost(positionals[0] ?? '')
    if (!host) throw new Rejected(`not a valid host name: ${positionals[0] ?? '(none)'}`)
    const r = await d.pg.query<{ id: string; verification_token: string; verified: boolean }>(
      'SELECT id, verification_token, verified FROM domains WHERE host = $1',
      [host],
    )
    const row = r.rows[0]
    if (!row) throw new Rejected(`unknown domain: ${host} (add it with "clickmonk domain add")`)
    const result = await checkDomain(resolver, host, row.verification_token)
    await recordDomainCheck(d.pg, row, result, now)
    if (result.status === 'verified') {
      d.out(`${host}: verified (${result.detail})`)
      return true
    }
    if (row.verified) {
      // Already verified — by `--verified`, or by an earlier check — and
      // this check's failure to find the token does not change that: the
      // domain keeps serving and keeps whatever certificate it has, so this
      // is not the same event as a domain that has never been verified.
      d.out(`${host}: still verified (${result.detail})`)
      printVerificationRecords(host, row.verification_token, d, { alreadyServing: true })
      return true
    }
    d.out(`${host}: ${result.status} (${result.detail})`)
    printVerificationRecords(host, row.verification_token, d)
    return false
  } finally {
    resolver.cancel()
  }
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

  const safe = NON_HUMAN_CLASSES.filter((c) => input.trafficActions[c] === 'safe')
  if (safe.length > 0 && (await servedSettings(d)).settings.safeUrl === null) {
    d.out(
      `note: ${safe.join(', ')} set to safe, but no safe URL is set, so those clicks are flagged until one is (clickmonk settings set --safe-url <url>)`,
    )
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
 * The settings the redirect serves: a row that is missing (deleted by hand)
 * or that core's schema refuses means the defaults there, so it does here
 * too, with a note saying why.
 */
async function servedSettings(d: CliDeps): Promise<{ settings: TrafficSettings; note?: string }> {
  const r = await d.pg.query<SettingsRow>(
    'SELECT traffic_actions, safe_url, abuser_threshold FROM settings',
  )
  const row = r.rows[0]
  if (!row) {
    return {
      settings: DEFAULT_TRAFFIC_SETTINGS,
      note: 'note: no settings are stored; the defaults apply',
    }
  }
  const parsed = TrafficSettingsSchema.safeParse(toSettings(row))
  if (parsed.success) return { settings: parsed.data }
  const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return {
    settings: DEFAULT_TRAFFIC_SETTINGS,
    note: `note: the stored settings are invalid (${why}); the defaults apply`,
  }
}

async function settingsShow(d: CliDeps): Promise<void> {
  const { settings, note } = await servedSettings(d)
  if (note) d.out(note)
  printSettings(settings, d)
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

/**
 * Returns the process exit code: 0 ok, 1 usage, 2 rejected input, 4 an IP
 * data source failed to update, 5 a domain is still not verified. (3 is the
 * entry point's code for an unexpected error.)
 */
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
    if (cmd === 'domain' && sub === 'list' && rest.length === 0) {
      await domainList(d)
      return 0
    }
    if (cmd === 'domain' && sub === 'verify' && rest.length <= 1) {
      return (await domainVerify(rest, d)) ? 0 : 5
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
