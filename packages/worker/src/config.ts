import { DEFAULT_SPOOL_DIR, formatConfigError } from '@clickmonk/core'
import type { ChConfig } from '@clickmonk/db'
import { DEFAULT_IPDATA_DIR } from '@clickmonk/ipdata'
import { z } from 'zod'

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
})

export interface WorkerConfig {
  postgresUrl: string
  ch: ChConfig
  spoolDir: string
  ipdataDir: string
  ipdataUpdate: boolean
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
  }
}
