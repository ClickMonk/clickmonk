import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { txtRecordsCarryToken, verificationRecordName } from '@clickmonk/core'
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
  if (bracketed) return isIP(bracketed[1] as string) === 6 && Number(bracketed[2]) <= 65535
  const withPort = /^([0-9.]+):(\d{1,5})$/.exec(entry)
  if (withPort) return isIP(withPort[1] as string) === 4 && Number(withPort[2]) <= 65535
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

/** Never rejects: an address lookup that fails is an empty list, not a failed check. */
async function addressesOf(resolver: DomainResolver, host: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  const out: string[] = []
  for (const r of [v4, v6]) if (r.status === 'fulfilled') out.push(...r.value)
  return out
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
  const addresses = await addressesOf(resolver, host)
  const shown = addresses.slice(0, MAX_ADDRESSES).join(', ')
  const more =
    addresses.length > MAX_ADDRESSES ? ` and ${addresses.length - MAX_ADDRESSES} more` : ''
  return {
    status: 'verified',
    detail: cut(
      addresses.length === 0
        ? `token found; ${host} has no A or AAAA record, so nothing reaches this install yet`
        : `token found; ${host} resolves to ${shown}${more}`,
    ),
  }
}

export interface DomainRow {
  id: string
  host: string
  verification_token: string
  verified: boolean
}

export interface DomainCheckRun {
  checked: number
  verified: number
  failed: number
}

/** How many domains one pass looks at. The oldest check first, so every domain comes round. */
export const DEFAULT_CHECK_LIMIT = 50

/**
 * Checks the domains whose last check is oldest, writes each result, and
 * marks a domain verified the first time its token is found.
 *
 * The `UPDATE domains` is issued only when a domain that is not verified just
 * proved itself. `config_changed` is a statement trigger, so it fires even
 * for an update that matches no row: running it every pass would make the
 * redirect reload its whole configuration every few minutes for nothing.
 * A domain is never un-verified here — a resolver outage or a DNS edit must
 * not take live links down or stop a certificate renewing.
 */
export async function runDomainChecks(o: {
  pg: Pool
  resolver: DomainResolver
  now?: () => Date
  limit?: number
  /** Stopping: the pass ends without recording the result of the check it abandoned. */
  signal?: AbortSignal
  log?: (msg: string) => void
}): Promise<DomainCheckRun> {
  const now = (o.now ?? (() => new Date()))()
  const limit = o.limit ?? DEFAULT_CHECK_LIMIT
  const rows = await o.pg.query<DomainRow>(
    `SELECT d.id, d.host, d.verification_token, d.verified
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
    await o.pg.query(
      `INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain_id) DO UPDATE
         SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
      [row.id, result.status, result.detail, now],
    )
    if (result.status === 'verified' && !row.verified) {
      await o.pg.query('UPDATE domains SET verified = true, updated_at = $2 WHERE id = $1', [
        row.id,
        now,
      ])
      o.log?.(`domain ${row.host} verified: ${result.detail}`)
    } else if (result.status !== 'verified') {
      o.log?.(`domain ${row.host} not verified: ${result.detail}`)
    }
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
  const interval = o.intervalMs ?? 300_000
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
        const r = await runDomainChecks({
          pg: o.pg,
          resolver: o.resolver,
          signal: abort.signal,
          log: (m) => log(m),
          ...(o.limit === undefined ? {} : { limit: o.limit }),
        })
        if (r.verified > 0) log(`domain check: ${r.verified} newly verified`)
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
