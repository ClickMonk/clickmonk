import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPgPool } from '@clickmonk/db'
import { buildRedirectApp } from './app.js'
import { loadConfig } from './config.js'
import { buildInternalApp } from './internal.js'
import { SnapshotStore } from './snapshot.js'
import { SpoolWriter } from './spool.js'

const config = loadConfig(process.env)

// Two pools: one for snapshot loads, one for the cap counter on the request
// path. tryConsumeCap bounds each call at 150 ms; the pool's own timeouts
// only stop a connection or query it abandoned from lingering.
const configPool = createPgPool(config.postgresUrl, { max: 2 })
const capPool = createPgPool(config.postgresUrl, {
  max: 10,
  queryTimeoutMs: 1000,
  connectTimeoutMs: 1000,
})

mkdirSync(dirname(config.snapshotPath), { recursive: true })
const spool = new SpoolWriter({
  dir: config.spoolDir,
  maxTotalBytes: config.spoolMaxBytes,
  onError: (err) => console.error('spool error', err),
})
spool.start()

const store = new SnapshotStore({
  pgUrl: config.postgresUrl,
  pool: configPool,
  filePath: config.snapshotPath,
  log: (msg, err) => console.error(`snapshot: ${msg}`, err ?? ''),
})
await store.start()

const app = buildRedirectApp(
  { snapshot: () => store.current(), spool, capPool, secret: config.secret },
  { trustProxy: config.trustedProxies },
)
const internal = buildInternalApp({ snapshot: () => store.current(), spool })

await internal.listen({ host: '0.0.0.0', port: config.internalPort })
await app.listen({ host: '0.0.0.0', port: config.port })

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'draining')
  try {
    // Stop accepting, let in-flight requests finish (each writes its record
    // before responding), then seal the open segment.
    await app.close()
    spool.close()
    await internal.close()
    await store.stop()
    await Promise.allSettled([configPool.end(), capPool.end()])
  } catch (err) {
    console.error('shutdown error', err)
    process.exitCode = 1
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
