#!/usr/bin/env node
import { formatConfigError } from '@clickmonk/core'
import { type ClickHouseClient, createChClient, createPgPool } from '@clickmonk/db'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'
import { runCli } from './commands.js'

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
      ipdata: { dir: process.env.CLICKMONK_IPDATA_DIR || DEFAULT_IPDATA_DIR },
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
