import { join } from 'node:path'
import { createChClient, createPgPool } from '@clickmonk/db'
import { buildAdminApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)

// One small pool: this service answers an operator and a script, not visitors.
// A query timeout so a request blocked behind DDL gives its connection back
// rather than holding one of four for as long as the migration takes.
//
// A connect timeout for the other direction: waiting for a client out of the
// pool is unbounded by default, so a handler that asks for one it can never
// get — because Postgres is unreachable, or because the pool is exhausted —
// hangs that request forever and takes the next one down with it. Bounded, the
// same fault is a 500 someone can read in the log.
const pg = createPgPool(config.postgresUrl, {
  max: 4,
  queryTimeoutMs: 15_000,
  connectTimeoutMs: 5_000,
})

// One client, built here rather than per request: it is an HTTP client with a
// connection pool of its own, and building one per request would open a
// connection per report. A bounded request timeout for the same reason the
// pool has one — a query that never answers must not hold a request open for
// ever — and it is longer than the server-side bound each query carries, so
// that a query ClickHouse itself refuses comes back as ClickHouse's error and
// not as a client-side abort with nothing in it.
const ch = createChClient({ ...config.ch, requestTimeoutMs: 30_000 })

const app = buildAdminApp(
  {
    pg,
    ch,
    adminHost: config.adminHost,
    dnsServers: config.dnsServers,
    ipdataDir: config.ipdataDir,
    uiDir: join(import.meta.dirname, '..', '..', 'ui', 'dist'),
  },
  { trustProxy: config.trustedProxies },
)

// Published nowhere: Caddy reaches it on the stack's own network, by the admin
// host name alone. Bound on every interface of the container, as the redirect
// is, because that is where Caddy connects from.
await app.listen({ host: '0.0.0.0', port: config.port })
if (config.adminHost === null) {
  app.log.warn('CLICKMONK_ADMIN_HOST is not set: every request is answered 503 until it is')
}

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'draining')
  try {
    // All three, whatever any one of them does. Closed in sequence, a server
    // that fails to drain leaves the pool and the ClickHouse client open, and
    // the process exits holding its sockets. `allSettled` never rejects, so a
    // failure is reported from the results rather than from the catch below —
    // which still stands, because a throw before the first await is possible.
    for (const closed of await Promise.allSettled([app.close(), pg.end(), ch.close()])) {
      if (closed.status === 'rejected') {
        console.error('shutdown error', closed.reason)
        process.exitCode = 1
      }
    }
  } catch (err) {
    console.error('shutdown error', err)
    process.exitCode = 1
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
