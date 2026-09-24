import { createPgPool } from '@clickmonk/db'
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

const app = buildAdminApp(
  {
    pg,
    adminHost: config.adminHost,
    dnsServers: config.dnsServers,
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
    await app.close()
    await pg.end()
  } catch (err) {
    console.error('shutdown error', err)
    process.exitCode = 1
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
