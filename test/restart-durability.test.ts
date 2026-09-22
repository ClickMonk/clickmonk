import { execFile, execFileSync } from 'node:child_process'
import http from 'node:http'
import { promisify } from 'node:util'
import { createChClient } from '@clickmonk/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const FILE = ['compose', '-f', 'docker-compose.ci.yml']
const composeSync = (...args: string[]) =>
  execFileSync('docker', [...FILE, ...args], { encoding: 'utf8', stdio: 'pipe' })
const compose = (...args: string[]) => run('docker', [...FILE, ...args])

const HOST = 'go.example.test'
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'clickmonk',
  password: 'clickmonk',
  database: 'clickmonk',
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Status code, or 0 when the request itself failed (connection refused, reset, timeout). */
function click(): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: 8080,
        path: '/d',
        headers: { host: HOST },
        agent: false,
        timeout: 5000,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(0))
  })
}

async function recordedTargets(): Promise<number> {
  const rs = await ch.query({
    query: `SELECT uniqExact(click_id) AS n FROM clicks WHERE host = {host:String} AND outcome = 'target'`,
    query_params: { host: HOST },
    format: 'JSONEachRow',
  })
  const [r] = await rs.json<{ n: string }>()
  return Number(r?.n ?? 0)
}

beforeAll(async () => {
  // Volumes survive `down`; a run that died before afterAll would leave its
  // domain behind and `domain add` would fail. Start from nothing.
  composeSync('down', '-v')
  // --build: the image tag is reused, so without it the suite tests an old build.
  composeSync('up', '-d', '--build', '--wait')
  // The worker migrates on boot; wait for the tables before adding config.
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      composeSync(
        'exec',
        '-T',
        'worker',
        'node',
        'packages/cli/dist/index.js',
        'domain',
        'add',
        HOST,
      )
      break
    } catch (err) {
      if (Date.now() > deadline) throw err
      await sleep(2000)
    }
  }
  composeSync(
    'exec',
    '-T',
    'worker',
    'node',
    'packages/cli/dist/index.js',
    'link',
    'add',
    HOST,
    'd',
    '--target',
    'https://example.com/landing',
  )
  // The redirect picks the link up through config_changed.
  const linkDeadline = Date.now() + 60_000
  while ((await click()) !== 302) {
    if (Date.now() > linkDeadline)
      throw new Error('the redirect never answered the new link with a 302')
    await sleep(250)
  }
}, 600_000)

// Set by the test's last line. Anything short of that leaves the stack's
// logs in the output before `down -v` removes the containers that hold them.
let passed = false

afterAll(async () => {
  await ch.close()
  if (!passed) console.error(composeSync('logs', '--no-color', '--tail', '300'))
  composeSync('down', '-v')
})

describe('restart durability', () => {
  it('keeps every accepted click through restarts of clickhouse, the worker and the redirect', async () => {
    // The warm-up loop above received exactly one 302 that counts.
    let accepted = 1
    let errored = 0
    let running = true

    const load = async () => {
      while (running) {
        const s = await click()
        if (s === 302) accepted++
        else if (s === 0) errored++
      }
    }
    const loaders = Array.from({ length: 4 }, load)

    await sleep(3000)
    await compose('restart', 'clickhouse')
    await sleep(3000)
    await compose('stop', 'worker')
    await sleep(4000)
    await compose('start', 'worker')
    await sleep(3000)
    // SIGTERM: the redirect drains in-flight requests and seals its segment.
    await compose('restart', 'redirect')
    await sleep(4000)
    // A crash, not a drain: no shutdown handler runs. Lines already written
    // are in the kernel's page cache and on the volume; the open segment is
    // sealed by the next start.
    await compose('kill', '-s', 'SIGKILL', 'redirect')
    await compose('start', 'redirect')
    await sleep(4000)
    running = false
    await Promise.all(loaders)

    // Let the worker drain the spool.
    const deadline = Date.now() + 120_000
    let recorded = await recordedTargets()
    while (recorded < accepted && Date.now() < deadline) {
      await sleep(1000)
      recorded = await recordedTargets()
    }

    // Printed before the assertions so a failing run still shows the counts.
    console.log(JSON.stringify({ accepted, recorded, errored }))
    expect(accepted).toBeGreaterThan(200)
    // Nothing the client was told about is missing.
    expect(recorded).toBeGreaterThanOrEqual(accepted)
    // Anything extra is a request that reached the spool and then lost its
    // response on the way back; there can be no more of those than errors.
    expect(recorded).toBeLessThanOrEqual(accepted + errored)
    passed = true
  })
})
