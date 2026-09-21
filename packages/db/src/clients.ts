import { type ClickHouseClient, createClient } from '@clickhouse/client'
import pg from 'pg'

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient
export type { ClickHouseClient }

export interface ChConfig {
  url: string
  username: string
  password: string
  database: string
}

export interface PgPoolOptions {
  max?: number
  /** Client-side bound on every query. */
  queryTimeoutMs?: number
  connectTimeoutMs?: number
  /** Called when an idle pooled connection fails. Default: logged to stderr. */
  onError?: (err: Error) => void
}

/**
 * A pool always has an 'error' listener. pg emits 'error' when an idle
 * connection dies (Postgres restarted, a connection killed), and an
 * EventEmitter with no listener for it throws, which would take the whole
 * process down over a connection nobody was using. The pool discards that
 * connection and opens a new one on the next query.
 */
export function createPgPool(url: string, opts: PgPoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    ...(opts.queryTimeoutMs !== undefined ? { query_timeout: opts.queryTimeoutMs } : {}),
    ...(opts.connectTimeoutMs !== undefined
      ? { connectionTimeoutMillis: opts.connectTimeoutMs }
      : {}),
  })
  pool.on('error', opts.onError ?? ((err) => console.error('postgres pool error', err)))
  return pool
}

export function createChClient(cfg: ChConfig): ClickHouseClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
  })
}
