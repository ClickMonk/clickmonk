import { DEFAULT_SPOOL_DIR, MAX_TIMER_MS, formatConfigError } from '@clickmonk/core'
import type { ChConfig } from '@clickmonk/db'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'
import { isResolverAddress } from './domains.js'

const DnsServers = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  )
  .superRefine((entries, ctx) => {
    for (const e of entries) {
      if (!isResolverAddress(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `not a resolver address, optionally with a port ([2001:db8::1]:53 for IPv6): ${e}`,
        })
      }
    }
  })

/**
 * Client-side bound on one ClickHouse request from this service.
 *
 * Not a tuning knob: it is the outer half of what stops a store that has
 * stopped answering from holding a Postgres row lock open. The retention pass
 * takes the settings row's lock and then talks to ClickHouse, so a request that
 * never comes back is a settings write that never goes through. Longer than the
 * `max_execution_time` the pass sends, so a statement ClickHouse itself ends
 * arrives as ClickHouse's error and not as an abort with nothing in it, and long
 * enough for the shipper's largest segment — an insert that times out is kept
 * and retried, so the cost of being wrong here is a pass, not a click.
 */
export const CH_REQUEST_TIMEOUT_MS = 60_000

const Schema = z.object({
  CLICKMONK_POSTGRES_URL: z.string().url(),
  CLICKMONK_CLICKHOUSE_URL: z.string().url(),
  CLICKMONK_CLICKHOUSE_USER: z.string().min(1),
  CLICKMONK_CLICKHOUSE_PASSWORD: z.string(),
  CLICKMONK_CLICKHOUSE_DB: z.string().min(1),
  CLICKMONK_SPOOL_DIR: z.string().min(1).default(DEFAULT_SPOOL_DIR),
  CLICKMONK_IPDATA_DIR: z.string().min(1).default(DEFAULT_IPDATA_DIR),
  // Off on a host without internet access; the redirect then runs without IP data.
  CLICKMONK_IPDATA_UPDATE: z.enum(['on', 'off']).default('on'),
  // Off on an install whose domains are verified some other way, or in a
  // test stack with no DNS to ask.
  CLICKMONK_DNS_CHECK: z.enum(['on', 'off']).default('on'),
  // Bounded at both ends. The ceiling is `setTimeout`'s, not a preference: past
  // it Node substitutes a delay of 1 ms, so an interval a little over twenty-five
  // days becomes a check running a hundred and seventy times a second. The loop
  // this reaches refuses the same range, because a bound that lives only here is
  // one a direct caller does not have.
  CLICKMONK_DNS_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMER_MS)
    .default(300_000),
  // Empty: the host's own resolvers. Otherwise the addresses to ask, each
  // validated here rather than inside node:dns, which throws at the first
  // query with a message that names nothing.
  CLICKMONK_DNS_SERVERS: DnsServers,
  // How often the retention pass runs. There is no on/off here on purpose:
  // "never" is a value the setting takes, and two ways to turn one thing off
  // is how they come to disagree.
  // The same ceiling as the DNS interval above, and for the same reason: this one
  // is where it was measured. A monthly pass typed as 2,147,483,648 ms ran 342
  // times in two seconds, each pass taking the settings row's lock.
  CLICKMONK_RETENTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMER_MS)
    .default(3_600_000),
})

export interface WorkerConfig {
  postgresUrl: string
  ch: ChConfig
  spoolDir: string
  ipdataDir: string
  ipdataUpdate: boolean
  dnsCheck: boolean
  dnsCheckIntervalMs: number
  dnsServers: string[]
  retentionIntervalMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const r = Schema.safeParse(env)
  if (!r.success) throw new Error(formatConfigError(r.error))
  const e = r.data
  return {
    postgresUrl: e.CLICKMONK_POSTGRES_URL,
    ch: {
      url: e.CLICKMONK_CLICKHOUSE_URL,
      username: e.CLICKMONK_CLICKHOUSE_USER,
      password: e.CLICKMONK_CLICKHOUSE_PASSWORD,
      database: e.CLICKMONK_CLICKHOUSE_DB,
      requestTimeoutMs: CH_REQUEST_TIMEOUT_MS,
    },
    spoolDir: e.CLICKMONK_SPOOL_DIR,
    ipdataDir: e.CLICKMONK_IPDATA_DIR,
    ipdataUpdate: e.CLICKMONK_IPDATA_UPDATE === 'on',
    dnsCheck: e.CLICKMONK_DNS_CHECK === 'on',
    dnsCheckIntervalMs: e.CLICKMONK_DNS_CHECK_INTERVAL_MS,
    dnsServers: e.CLICKMONK_DNS_SERVERS,
    retentionIntervalMs: e.CLICKMONK_RETENTION_INTERVAL_MS,
  }
}
