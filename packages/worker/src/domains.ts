import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  checkIntervalMs,
  isDomainUrl,
  newVerificationToken,
  normaliseHost,
  txtRecordsCarryToken,
  verificationRecordName,
} from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'

/**
 * What the last DNS check found.
 *
 * `error` is deliberately not `missing_token`: a SERVFAIL, a timeout or a
 * resolver that refused the query says nothing about the domain, only about
 * this install's ability to ask. Treating it as evidence would report a
 * correctly configured domain as unproven every time the resolver hiccups.
 */
export type DomainDnsStatus = 'verified' | 'missing_token' | 'error'

export interface DomainCheck {
  status: DomainDnsStatus
  /** One line for the operator. Bounded to what the column accepts. */
  detail: string
}

/** The part of `node:dns/promises`'s `Resolver` this uses; a test passes its own. */
export interface DomainResolver {
  resolveTxt(hostname: string): Promise<string[][]>
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  /** Rejects every query in flight at once, so stopping is not a wait. */
  cancel(): void
}

/**
 * One resolver address, as `node:dns` accepts it: an address, or an address
 * with a port — `192.0.2.1:5353`, or `[2001:db8::1]:5353` for IPv6. Checked
 * here rather than inside node:dns, which throws at the first query with a
 * message that names neither the value nor the variable it came from.
 */
export function isResolverAddress(entry: string): boolean {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(entry)
  if (bracketed) {
    const port = Number(bracketed[2])
    return isIP(bracketed[1] as string) === 6 && port >= 1 && port <= 65535
  }
  const withPort = /^([0-9.]+):(\d{1,5})$/.exec(entry)
  if (withPort) {
    const port = Number(withPort[2])
    return isIP(withPort[1] as string) === 4 && port >= 1 && port <= 65535
  }
  return isIP(entry) !== 0
}

/**
 * The resolver the worker and `domain verify` use: a short timeout and one
 * retry, so a domain that does not answer now is simply checked again rather
 * than holding a pass open. With no servers given, the host's own.
 */
export function createResolver(servers: readonly string[] = []): DomainResolver {
  const resolver = new Resolver({ timeout: 5000, tries: 2 })
  if (servers.length > 0) resolver.setServers([...servers])
  return resolver
}

/** The column's bound. A detail longer than this is cut rather than refused by Postgres. */
export const MAX_DETAIL = 500
/** Addresses named in the detail. The rest are counted, not listed. */
export const MAX_ADDRESSES = 8

/** Codes that mean "the record is not there". Everything else is the resolver's trouble, not the domain's. */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA'])

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code: unknown }).code
    if (typeof c === 'string' && c !== '') return c
  }
  return err instanceof Error ? err.message : String(err)
}

const cut = (s: string): string => (s.length <= MAX_DETAIL ? s : `${s.slice(0, MAX_DETAIL - 1)}…`)

interface AddressLookup {
  addresses: string[]
  /**
   * Codes from a lookup that failed for a reason other than "there is no
   * such record" — the resolver couldn't say, not that there's nothing
   * there. Reuses `ABSENT`, the same distinction the TXT lookup makes.
   */
  failed: string[]
}

/** Never rejects: an address lookup that fails is an empty list or a failure code, never a thrown error. */
async function addressesOf(resolver: DomainResolver, host: string): Promise<AddressLookup> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  const addresses: string[] = []
  const failed: string[] = []
  for (const r of [v4, v6]) {
    if (r.status === 'fulfilled') addresses.push(...r.value)
    else {
      const code = errorCode(r.reason)
      if (!ABSENT.has(code)) failed.push(code)
    }
  }
  return { addresses, failed }
}

/**
 * Looks the domain's TXT token up, and records what the host resolves to.
 *
 * The addresses are reported, never judged: an install behind NAT, a load
 * balancer or a CDN does not know its own public address, so requiring a
 * match would refuse correct setups. The token is what proves control.
 */
export async function checkDomain(
  resolver: DomainResolver,
  host: string,
  token: string,
): Promise<DomainCheck> {
  const name = verificationRecordName(host)
  let records: string[][]
  try {
    records = await resolver.resolveTxt(name)
  } catch (err) {
    const code = errorCode(err)
    return ABSENT.has(code)
      ? { status: 'missing_token', detail: cut(`no TXT record at ${name}`) }
      : { status: 'error', detail: cut(`could not look ${name} up: ${code}`) }
  }
  if (!txtRecordsCarryToken(records, token)) {
    return {
      status: 'missing_token',
      detail: cut(`${name} has ${records.length} TXT record(s), none of them this install's token`),
    }
  }
  const { addresses, failed } = await addressesOf(resolver, host)
  const shown = addresses.slice(0, MAX_ADDRESSES).join(', ')
  const more =
    addresses.length > MAX_ADDRESSES ? ` and ${addresses.length - MAX_ADDRESSES} more` : ''
  // A lookup that failed is reported as failed, not folded into "no record":
  // stating "no A or AAAA record" as fact during a resolver outage would
  // tell the operator something this install never actually learned.
  const detail =
    addresses.length > 0
      ? `token found; ${host} resolves to ${shown}${more}`
      : failed.length > 0
        ? `token found; ${host}'s address could not be looked up (${failed.join(', ')})`
        : `token found; ${host} has no A or AAAA record, so nothing reaches this install yet`
  return { status: 'verified', detail: cut(detail) }
}

export interface DomainRow {
  id: string
  host: string
  verification_token: string
  verified: boolean
  /** The status this domain's last check recorded, or `null` if it has never been checked. */
  previous_status: DomainDnsStatus | null
}

export interface CreatedDomain {
  id: string
  host: string
  /** Published as a TXT record by the admin; not a secret, and printed freely. */
  verificationToken: string
}

/**
 * Thrown when the host asked for is the one the admin API answers on.
 *
 * Its own class rather than a bare `Error` because, unlike the other two
 * refusals here, this one is reachable from an operator's first attempt: a
 * name that looks exactly right is the name they would try. Each caller catches
 * it and words the refusal for its own surface, the way each already words the
 * `null` that means the host is taken — a 500 or a stack trace for a typo would
 * be the wrong answer on either of them.
 */
export class AdminHostDomainError extends Error {
  constructor(readonly host: string) {
    super(`${host} is the host name the admin API answers on`)
    this.name = 'AdminHostDomainError'
  }
}

/**
 * Adds a domain, and is the only place that writes one. Shared by the API and
 * by `clickmonk domain add`, for the same reason `recordDomainCheck` is: the
 * flag this writes decides whether a host name's links answer and whether
 * this install asks a certificate authority for a certificate in its name,
 * and a second copy of the statement is a second place for that flag to be
 * got wrong.
 *
 * `verified` is false unless a caller asks for it, and the only caller that
 * may ask is one already running on the server — `domain add --verified`,
 * typed by whoever installed it. Nothing reachable over the network passes
 * it: the API's own body schema is strict, so a `verified` field is a 400,
 * and its route never forwards one.
 *
 * The host and the URLs are checked here rather than only in the schema in
 * front of an HTTP request, because this function has callers with no schema
 * in front of them. Both existing callers reject the same values first, so
 * nothing either of them answers changes; what this stops is the next caller.
 * Returns `null` when the host is already taken, which each caller reports in
 * its own words.
 *
 * `adminHost` is required, and null is how a caller says this install has not
 * named one. Optional, a caller who knows the name and forgets to pass it loses
 * the rule silently — and what it decides is whether a domain's links resolve
 * at all, which is the same reason `verified` has to be asked for in so many
 * words rather than defaulted from somewhere.
 */
export async function createDomain(
  pg: Pool,
  o: {
    host: string
    /** The host name the admin API answers on, or null when none is configured. */
    adminHost: string | null
    rootUrl?: string | null
    notFoundUrl?: string | null
    verified?: boolean
  },
): Promise<CreatedDomain | null> {
  const host = normaliseHost(o.host)
  if (!host) throw new Error('a domain needs a valid host name')
  // One rule, here, because both callers would otherwise need their own copy
  // of it. The reverse proxy sends the admin host name to the admin service, so
  // a link domain of that name would take every one of its links with it: they
  // would be stored, verified, given a certificate, and answer as the API does
  // instead of redirecting. Normalised on both sides, since the proxy matches a
  // host name without regard to case or a trailing dot.
  const adminHost = o.adminHost === null ? null : normaliseHost(o.adminHost)
  if (adminHost !== null && host === adminHost) throw new AdminHostDomainError(host)
  // An own property, not an inherited one. `o` is an object literal a caller
  // builds, and a plain `o.verified` walks the prototype chain: a property
  // planted on `Object.prototype` would then decide the flag that lets a host
  // name serve and be given a certificate, for every caller that says nothing
  // about it. Nothing reaches that today — the API's schema refuses a body
  // that carries the field at all — but a flag this one must be decided by
  // what the caller actually wrote.
  const verified = Object.hasOwn(o, 'verified') && o.verified === true
  for (const url of [o.rootUrl, o.notFoundUrl]) {
    // Sent to the visitor as written, so no token: a brace would reach them
    // literally.
    if (url !== null && url !== undefined && !isDomainUrl(url)) {
      throw new Error("a domain's URL must be an absolute http(s) URL with no token")
    }
  }
  const r = await pg.query<{ id: string; verification_token: string }>(
    `INSERT INTO domains (host, verified, root_url, not_found_url, verification_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (host) DO NOTHING RETURNING id, verification_token`,
    [host, verified, o.rootUrl ?? null, o.notFoundUrl ?? null, newVerificationToken()],
  )
  const row = r.rows[0]
  if (!row) return null
  return { id: row.id, host, verificationToken: row.verification_token }
}

export interface DomainCheckRun {
  checked: number
  verified: number
  failed: number
}

/** How many domains one pass looks at. The oldest check first, so every domain comes round. */
export const DEFAULT_CHECK_LIMIT = 50

/**
 * Writes one check's result and marks the domain verified the first time its
 * token is found. Shared by the worker's own pass and the CLI's `domain
 * verify`, so the two paths that record a check cannot drift apart by copy.
 *
 * The `UPDATE domains` is issued only when a domain that is not verified just
 * proved itself. `config_changed` is a statement trigger, so it fires even
 * for an update that matches no row: running it every time would make the
 * redirect reload its whole configuration for nothing. A domain is never
 * un-verified here — a resolver outage or a DNS edit must not take live
 * links down or stop a certificate renewing.
 */
export async function recordDomainCheck(
  pg: Pool,
  row: { id: string; verified: boolean },
  result: DomainCheck,
  now: Date,
): Promise<void> {
  await pg.query(
    `INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain_id) DO UPDATE
       SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
    [row.id, result.status, result.detail, now],
  )
  if (result.status === 'verified' && !row.verified) {
    await pg.query('UPDATE domains SET verified = true, updated_at = $2 WHERE id = $1', [
      row.id,
      now,
    ])
  }
}

/**
 * Checks the domains whose last check is oldest, writes each result via
 * `recordDomainCheck`, and marks a domain verified the first time its token
 * is found.
 */
export async function runDomainChecks(o: {
  pg: Pool
  resolver: DomainResolver
  now?: () => Date
  limit?: number
  /** Stopping: the pass ends without recording the result of the check it abandoned. */
  signal?: AbortSignal
  log?: (msg: string) => void
  /**
   * True logs one line per domain checked, whatever the transition — for a
   * command an operator just ran, who asked to see this domain's result
   * regardless of whether it changed. Default false: only a real change is
   * logged, for the five-minute background loop, where an unbroken run of
   * the same status must not write one line per domain every pass. Either
   * way, exactly one pass-summary line is logged.
   */
  logEvery?: boolean
}): Promise<DomainCheckRun> {
  const now = (o.now ?? (() => new Date()))()
  const limit = o.limit ?? DEFAULT_CHECK_LIMIT
  const rows = await o.pg.query<DomainRow>(
    `SELECT d.id, d.host, d.verification_token, d.verified, c.status AS previous_status
       FROM domains d
       LEFT JOIN domain_dns_checks c ON c.domain_id = d.id
      ORDER BY c.checked_at ASC NULLS FIRST, d.host ASC
      LIMIT $1`,
    [limit],
  )
  const run: DomainCheckRun = { checked: 0, verified: 0, failed: 0 }
  for (const row of rows.rows) {
    if (o.signal?.aborted) break
    const result = await checkDomain(o.resolver, row.host, row.verification_token)
    // Cancelling the resolver makes the check in flight fail; recording that
    // as a result would write "error" over a good check on every shutdown.
    if (o.signal?.aborted) break
    run.checked++
    if (result.status === 'verified') run.verified++
    else run.failed++
    await recordDomainCheck(o.pg, row, result, now)
    // Logged only on a real change: the first check for a domain, or a
    // status different from last pass's. An unbroken run of the same status
    // would otherwise write one line per failing domain every pass for as
    // long as an outage or a removed record lasts.
    if (o.logEvery || result.status !== row.previous_status) {
      o.log?.(
        result.status === 'verified'
          ? `domain ${row.host} verified: ${result.detail}`
          : `domain ${row.host} not verified (${result.status}): ${result.detail}`,
      )
    }
  }
  if (o.log && run.checked > 0) {
    o.log(`domain check: checked ${run.checked}, verified ${run.verified}, failed ${run.failed}`)
  }
  return run
}

/**
 * Runs the checks now and then every `intervalMs`. Never rejects. `stop()`
 * cancels the queries in flight, so it resolves in about as long as one
 * database round trip rather than one resolver timeout.
 */
export function startDomainChecker(o: {
  pg: Pool
  resolver: DomainResolver
  intervalMs?: number
  limit?: number
  log?: (msg: string, err?: unknown) => void
}): { stop(): Promise<void> } {
  // The same bound the retention loop takes, for the same reason: past
  // `setTimeout`'s 32-bit ceiling the delay is replaced by 1 ms, so an interval a
  // little over twenty-five days is a resolver query every few milliseconds.
  const interval = checkIntervalMs('intervalMs', o.intervalMs ?? 300_000)
  // The loop must never reject, so a logger that throws is ignored.
  const log = (msg: string, err?: unknown) => {
    try {
      o.log?.(msg, err)
    } catch {
      // A broken logger must not stop the checks.
    }
  }
  const abort = new AbortController()
  let stopped = false
  let wake: (() => void) | null = null

  const loop = (async () => {
    while (!stopped) {
      try {
        // The summary and any transitions are already logged inside
        // runDomainChecks itself, forwarded through this same log().
        await runDomainChecks({
          pg: o.pg,
          resolver: o.resolver,
          signal: abort.signal,
          log: (m) => log(m),
          ...(o.limit === undefined ? {} : { limit: o.limit }),
        })
      } catch (err) {
        log('domain check failed', err)
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = null
    }
  })()

  return {
    async stop() {
      stopped = true
      abort.abort()
      o.resolver.cancel()
      wake?.()
      await loop
    },
  }
}
