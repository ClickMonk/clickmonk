import { parseArgs } from 'node:util'
import { AccountExistsError, createAccount, setAccountPassword } from '@clickmonk/admin/account'
import {
  MAX_KEY_DAYS,
  MAX_KEY_NAME_LENGTH,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '@clickmonk/admin/keys'
import {
  DEFAULT_TRAFFIC_SETTINGS,
  MAX_PASSWORD_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH,
  NON_HUMAN_CLASSES,
  type TrafficActions,
  type TrafficSettings,
  TrafficSettingsSchema,
  isDomainUrl,
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
  createDomain,
  createResolver,
  recordDomainCheck,
  runDomainChecks,
} from '@clickmonk/worker/domains'
import { createLink } from '@clickmonk/worker/links'
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
  /**
   * The host name the admin API answers on, or null when this install has not
   * named one. `domain add` refuses it: the reverse proxy sends that name to
   * the admin service, so a link domain of the same name would accept links
   * that then never resolve.
   */
  adminHost?: string | null
  /**
   * Reads a password from standard input. A password never comes from an
   * argument: `argv` is visible to every process on the host through `ps`, and
   * it lands in the shell's history. A test passes its own.
   */
  stdin?: () => Promise<string>
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
  clickmonk ipdata status
  clickmonk admin create <email>      # the password is read from standard input
  clickmonk admin passwd              # the new password is read from standard input
  clickmonk apikey create <name> [--expires-days <n>]
  clickmonk apikey list
  clickmonk apikey revoke <id>`

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
  // Refused rather than stored, because storing it would look like it worked.
  // Requests for the admin host are sent to the admin API, so every link added
  // under this name would answer as the API does and none of them would ever
  // redirect — with a domain row, a verification record and a certificate all
  // saying the domain was set up correctly.
  if (d.adminHost !== null && d.adminHost !== undefined && host === d.adminHost) {
    throw new Rejected(
      `${host} is the host name the admin API answers on (CLICKMONK_ADMIN_HOST), so links on it would never resolve; use a different name for links`,
    )
  }
  for (const u of [values['root-url'], values['not-found-url']]) {
    // Sent as written, so no token: `{click_id}` would reach the visitor
    // literally. Checked here so the refusal names the value the operator
    // typed; the writer checks it again for callers that have no argument
    // parser in front of them.
    if (u !== undefined && !isDomainUrl(u))
      throw new Rejected(`not an http(s) URL in printable ASCII without tokens: ${u}`)
  }
  const verified = values.verified === true
  // The one writer, shared with the API, so `verified` is decided in one
  // statement. This is the only caller that may pass it true, and it can
  // because it is typed on the server by whoever installed this.
  const created = await createDomain(d.pg, {
    host,
    rootUrl: values['root-url'] ?? null,
    notFoundUrl: values['not-found-url'] ?? null,
    verified,
  })
  if (!created) throw new Rejected(`domain already exists: ${host}`)
  d.out(`domain ${host} ${created.id}`)
  if (verified) {
    d.out('marked verified without a DNS check, so it can be given a certificate at once')
    return
  }
  printVerificationRecords(host, created.verificationToken, d)
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

  // One writer, shared with the API: a link decides where somebody's traffic
  // goes, so the statement that writes one exists once. This command answers
  // its own refusals, and it never asks for a generated slug — the slug is a
  // positional argument here, so a collision is a refusal.
  const created = await createLink(d.pg, { host, link: input })
  if (!created.ok) {
    throw new Rejected(
      created.reason === 'unknown_domain'
        ? `unknown domain: ${host} (add it with "clickmonk domain add")`
        : created.reason === 'slug_taken'
          ? `slug already exists on ${host}: ${created.slug}`
          : 'could not find an unused slug; try again',
    )
  }
  d.out(`link ${host}/${created.link.slug} ${created.link.id}`)

  const safe = NON_HUMAN_CLASSES.filter((c) => input.trafficActions[c] === 'safe')
  if (safe.length > 0 && (await servedSettings(d)).settings.safeUrl === null) {
    d.out(
      `note: ${safe.join(', ')} set to safe, but no safe URL is set, so those clicks are flagged until one is (clickmonk settings set --safe-url <url>)`,
    )
  }
}

/**
 * The password on standard input, with one trailing newline removed so that
 * `printf 'pw\n' | clickmonk admin create …` and `printf 'pw'` mean the same
 * thing. Nothing here is printed or logged, ever — the refusal below says how
 * long what it read was, and never what it was.
 */
async function readPassword(d: CliDeps): Promise<string> {
  if (!d.stdin) throw new Rejected('no way to read the password: standard input is not available')
  const raw = await d.stdin()
  const password = raw.replace(/\r?\n$/, '')
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Rejected(
      `the password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters (read ${password.length} from standard input)`,
    )
  }
  // The ceiling as well as the floor, because what is on the far side of it is
  // not a refusal: the hash function throws, which reaches the operator as an
  // unexpected error and a stack trace rather than as something they can act
  // on. A whole file piped in by mistake is exactly how that happens.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Rejected(
      `the password must be at most ${MAX_PASSWORD_LENGTH} characters (read ${password.length} from standard input)`,
    )
  }
  return password
}

/**
 * Creates the one admin account. The API cannot do this — there is nothing to
 * authenticate as yet — so it is typed on the server by whoever installed it.
 */
async function adminCreate(args: string[], d: CliDeps): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const email = (positionals[0] ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Rejected(`not an email address: ${positionals[0] ?? '(none)'}`)
  }
  const password = await readPassword(d)
  try {
    await createAccount(d.pg, { email, password })
  } catch (err) {
    if (err instanceof AccountExistsError) throw new Rejected(err.message)
    throw err
  }
  d.out(`admin ${email} created`)
  d.out('')
  d.out('Set CLICKMONK_ADMIN_HOST in .env to the host name the admin API answers on,')
  d.out('point that name at this server, and restart the stack. Until it is set, the')
  d.out('admin service answers 503 and links keep serving as usual.')
}

/** Changes the password, and signs every browser out: a session minted under the old one is exactly what an attacker would still hold. */
async function adminPasswd(d: CliDeps): Promise<void> {
  const password = await readPassword(d)
  // The one writer, which clears the failure count and any standing lockout in
  // the same statement: this command is the way back in, and a lock over a
  // password that no longer exists would keep the only account out for nothing.
  await setAccountPassword(d.pg, password)
  const r = await d.pg.query('DELETE FROM sessions')
  d.out(`password changed; ${r.rowCount ?? 0} session(s) signed out`)
}

async function apikeyCreate(args: string[], d: CliDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'expires-days': { type: 'string' } },
  })
  const name = positionals[0] ?? ''
  if (name.length === 0 || name.length > MAX_KEY_NAME_LENGTH)
    throw new Rejected(`a key needs a name of 1 to ${MAX_KEY_NAME_LENGTH} characters`)
  let expiresAt: Date | null = null
  const now = d.now?.() ?? new Date()
  if (values['expires-days'] !== undefined) {
    // `Number('')` is 0 and `Number(' 7 ')` is 7, so the floor below is what
    // refuses an empty value rather than reading it as no expiry at all.
    const days = Number(values['expires-days'])
    if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) {
      throw new Rejected(`--expires-days takes a whole number of days from 1 to ${MAX_KEY_DAYS}`)
    }
    expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  }
  const created = await createApiKey(d.pg, { name, expiresAt, now })
  d.out(created.key)
  d.out('')
  d.out('That is the only time this key is shown. Store it somewhere safe; if it is lost,')
  d.out(`revoke it with "clickmonk apikey revoke ${created.id}" and make another.`)
}

async function apikeyList(d: CliDeps): Promise<void> {
  const { keys, truncated } = await listApiKeys(d.pg)
  if (keys.length === 0) {
    d.out('no API keys yet (make one with "clickmonk apikey create <name>")')
    return
  }
  for (const k of keys) {
    const state = k.revoked_at
      ? `revoked ${k.revoked_at.toISOString()}`
      : k.expires_at && k.expires_at.getTime() <= (d.now?.() ?? new Date()).getTime()
        ? `expired ${k.expires_at.toISOString()}`
        : 'active'
    const used = k.last_used_at ? `last used ${k.last_used_at.toISOString()}` : 'never used'
    d.out(`${k.id}  ${k.name}: ${state}; ${used}`)
  }
  // Said rather than left silent: a listing that stopped at the cap is a
  // prefix, and an operator managing the wrong set would never find out.
  if (truncated) d.out('(more keys than this list shows; revoke some)')
}

async function apikeyRevoke(args: string[], d: CliDeps): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const id = positionals[0] ?? ''
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Rejected(`not a key id: ${id || '(none)'}`)
  if (!(await revokeApiKey(d.pg, id, d.now?.() ?? new Date()))) {
    throw new Rejected(`no such key, or it was already revoked: ${id}`)
  }
  d.out(`key ${id} revoked`)
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
    if (cmd === 'admin' && sub === 'create') {
      await adminCreate(rest, d)
      return 0
    }
    if (cmd === 'admin' && sub === 'passwd' && rest.length === 0) {
      await adminPasswd(d)
      return 0
    }
    if (cmd === 'apikey' && sub === 'create') {
      await apikeyCreate(rest, d)
      return 0
    }
    if (cmd === 'apikey' && sub === 'list' && rest.length === 0) {
      await apikeyList(d)
      return 0
    }
    if (cmd === 'apikey' && sub === 'revoke') {
      await apikeyRevoke(rest, d)
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
