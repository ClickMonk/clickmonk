import { mkdirSync } from 'node:fs'
import { createChClient, createPgPool, migrateToLatest } from '@clickmonk/db'
import { startUpdater } from '@clickmonk/ipdata'
import { loadConfig } from './config.js'
import { createResolver, startDomainChecker } from './domains.js'
import { startShipper } from './shipper.js'

const config = loadConfig(process.env)
const pg = createPgPool(config.postgresUrl, { max: 2 })
const ch = createChClient(config.ch)
const log = (msg: string, err?: unknown) => console.error(`worker: ${msg}`, err ?? '')

let stopping = false
let shipper: { stop(): Promise<void> } | null = null
let updater: { stop(): Promise<void> } | null = null
let domains: { stop(): Promise<void> } | null = null

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await Promise.all([shipper?.stop(), updater?.stop(), domains?.stop()])
  await Promise.allSettled([pg.end(), ch.close()])
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// Migrate before shipping: the clicks table must exist. Retry until both
// stores answer; a stack started cold brings them up in any order.
while (!stopping) {
  try {
    const { applied } = await migrateToLatest(pg, ch)
    if (applied.length > 0) log(`applied migrations ${applied.join(', ')}`)
    break
  } catch (err) {
    log('migration failed; retrying in 5s', err)
    await new Promise((r) => setTimeout(r, 5000))
  }
}

if (!stopping) {
  mkdirSync(config.spoolDir, { recursive: true })
  shipper = startShipper({ dir: config.spoolDir, ch, log })
  log(`shipping ${config.spoolDir}`)
  mkdirSync(config.ipdataDir, { recursive: true })
  if (config.ipdataUpdate) {
    updater = startUpdater({ dir: config.ipdataDir, log })
    log(`updating IP data in ${config.ipdataDir}`)
  } else {
    log('IP data updates are off: countries stay unknown and the IP checks do not run')
  }
  if (config.dnsCheck) {
    domains = startDomainChecker({
      resolver: createResolver(config.dnsServers),
      pg,
      intervalMs: config.dnsCheckIntervalMs,
      log,
    })
    log('checking domain DNS verification')
  } else {
    log('domain DNS checks are off: a domain stays as it was added')
  }
}
