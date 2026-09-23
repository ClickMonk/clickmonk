#!/usr/bin/env node
import { formatConfigError, normaliseHost } from '@clickmonk/core'
import { type ClickHouseClient, createChClient, createPgPool } from '@clickmonk/db'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { isResolverAddress } from '@clickmonk/worker/domains'
import { z } from 'zod'
import { readStdin, runCli } from './commands.js'

// Every command but `ipdata` needs Postgres, and its URL is required up front
// all the same: the CLI runs where the worker runs, which always has it, and
// a pool opens no connection until its first query. ClickHouse serves only
// `migrate`, so its variables are checked when migrate asks for the client.
const PgEnv = z.object({ CLICKMONK_POSTGRES_URL: z.string().url() })
const ChEnv = z.object({
  CLICKMONK_CLICKHOUSE_URL: z.string().url(),
  CLICKMONK_CLICKHOUSE_USER: z.string().min(1),
  CLICKMONK_CLICKHOUSE_PASSWORD: z.string(),
  CLICKMONK_CLICKHOUSE_DB: z.string().min(1),
})

class ConfigError extends Error {}

async function main(): Promise<number> {
  const env = PgEnv.safeParse(process.env)
  if (!env.success) throw new ConfigError(formatConfigError(env.error))
  const pg = createPgPool(env.data.CLICKMONK_POSTGRES_URL, { max: 1 })
  // The same resolvers the worker asks, so `domain verify` and the worker's
  // own pass can never disagree about what DNS says.
  const dnsServers = (process.env.CLICKMONK_DNS_SERVERS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  for (const e of dnsServers) {
    if (!isResolverAddress(e)) {
      throw new ConfigError(`CLICKMONK_DNS_SERVERS: not a resolver address: ${e}`)
    }
  }
  const opened: { ch: ClickHouseClient | null } = { ch: null }
  const ch = (): ClickHouseClient => {
    if (opened.ch) return opened.ch
    const c = ChEnv.safeParse(process.env)
    if (!c.success) throw new ConfigError(formatConfigError(c.error))
    opened.ch = createChClient({
      url: c.data.CLICKMONK_CLICKHOUSE_URL,
      username: c.data.CLICKMONK_CLICKHOUSE_USER,
      password: c.data.CLICKMONK_CLICKHOUSE_PASSWORD,
      database: c.data.CLICKMONK_CLICKHOUSE_DB,
    })
    return opened.ch
  }
  try {
    return await runCli(process.argv.slice(2), {
      pg,
      ch,
      out: (s) => console.log(s),
      // Never echoed, and never typed: a password on the command line would be
      // visible in `ps` and left in the shell's history, and one typed at a
      // terminal would be on screen. `isTTY` is undefined when there is no
      // terminal on this end, which is what `docker compose exec -T` arranges.
      stdin: () => readStdin(process.stdin, { isTty: process.stdin.isTTY === true }),
      ipdata: { dir: process.env.CLICKMONK_IPDATA_DIR || DEFAULT_IPDATA_DIR },
      // Normalised rather than validated: the services parse this variable
      // strictly and refuse to boot on a value that is not a bare lower-case
      // host name, so the only job left here is to recognise the name a
      // reverse proxy would match case-insensitively. A value too malformed to
      // normalise leaves this null, and an install whose admin service will
      // not boot has no admin host to collide with.
      adminHost: normaliseHost(process.env.CLICKMONK_ADMIN_HOST ?? ''),
      dnsServers,
    })
  } finally {
    await Promise.allSettled([pg.end(), opened.ch?.close()])
  }
}

try {
  process.exitCode = await main()
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message)
    process.exitCode = 1
  } else {
    console.error(err)
    process.exitCode = 3
  }
}
