import { DEFAULT_SPOOL_DIR, formatConfigError } from '@clickmonk/core'
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
  CLICKMONK_DNS_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  // Empty: the host's own resolvers. Otherwise the addresses to ask, each
  // validated here rather than inside node:dns, which throws at the first
  // query with a message that names nothing.
  CLICKMONK_DNS_SERVERS: DnsServers,
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
    },
    spoolDir: e.CLICKMONK_SPOOL_DIR,
    ipdataDir: e.CLICKMONK_IPDATA_DIR,
    ipdataUpdate: e.CLICKMONK_IPDATA_UPDATE === 'on',
    dnsCheck: e.CLICKMONK_DNS_CHECK === 'on',
    dnsCheckIntervalMs: e.CLICKMONK_DNS_CHECK_INTERVAL_MS,
    dnsServers: e.CLICKMONK_DNS_SERVERS,
  }
}
