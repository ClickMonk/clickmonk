import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPgPool } from '@clickmonk/db'
import { IpDataStore } from '@clickmonk/ipdata'
import { buildRedirectApp } from './app.js'
import { loadConfig } from './config.js'
import { buildInternalApp } from './internal.js'
import { RateCounter } from './rate.js'
import { SnapshotStore } from './snapshot.js'
import { SpoolWriter } from './spool.js'

const config = loadConfig(process.env)

// Two pools: one for snapshot loads, one for the cap counter on the request
// path. tryConsumeCap and checkCap bound each call at 150 ms; the pool's own timeouts
// only stop a connection or query it abandoned from lingering.
// The query timeout is generous: a snapshot load of a large install is a
// long read, and a reload that fails keeps the previous snapshot. It is
// there so a reload stuck on a lock gives its connection back rather than
// holding one of two forever.
const configPool = createPgPool(config.postgresUrl, { max: 2, queryTimeoutMs: 30_000 })
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

// Written by the worker; read here, whole, into memory, at start and when
// the manifest changes, never inside a request. Not awaited: the redirect
// answers while the tables load, and without them it still serves:
// countries are unknown and the IP checks do not run.
const ipdata = new IpDataStore({
  dir: config.ipdataDir,
  log: (msg, err) => console.error(`ipdata: ${msg}`, err ?? ''),
})
const ipdataStarted = ipdata.start()
/** How long shutdown waits for a start still loading the IP data. */
const IPDATA_STOP_WAIT_MS = 5_000
const rate = new RateCounter()

const app = buildRedirectApp(
  {
    snapshot: () => store.current(),
    spool,
    capPool,
    secret: config.secret,
    ipdata: () => ipdata.current(),
    rate,
  },
  { trustProxy: config.trustedProxies },
)
const internal = buildInternalApp({
  snapshot: () => store.current(),
  spool,
  ipdata: () => ipdata.status(),
  rate,
  adminHost: config.adminHost,
})

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
    // A start still loading would set its poll timer after a stop, so wait
    // for it, but not for long: a stalled disk read must not hang the drain.
    // The poll timer is unref'd and cannot keep the process alive.
    let waited: NodeJS.Timeout | undefined
    await Promise.race([
      ipdataStarted,
      new Promise<void>((resolve) => {
        waited = setTimeout(resolve, IPDATA_STOP_WAIT_MS)
      }),
    ])
    clearTimeout(waited)
    ipdata.stop()
    await Promise.allSettled([configPool.end(), capPool.end()])
  } catch (err) {
    console.error('shutdown error', err)
    process.exitCode = 1
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
