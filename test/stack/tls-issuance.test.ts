import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CA_MOUNT,
  WAIT_TIMEOUT,
  cli,
  compose,
  curl,
  publishZone,
  until,
  upWait,
  writeAcmeRoot,
  writeIssuingRoot,
} from './stack.js'

const VERIFIED = 'go.example.test'
const PENDING = 'pending.example.test'

/** The token `domain add` minted for each host, taken from what it printed. */
const tokens: Record<string, string> = {}

function add(host: string): void {
  const out = cli('domain', 'add', host)
  const m = new RegExp(
    `_clickmonk\\.${host.replace(/\./g, '\\.')}  TXT  "clickmonk-verify=([0-9a-f]{32})"`,
  ).exec(out)
  if (!m) throw new Error(`domain add printed no verification record for ${host}: ${out}`)
  tokens[host] = m[1] as string
  cli('link', 'add', host, 'd', '--target', 'https://example.com/landing')
}

/**
 * Everything the local certificate authority has logged. It names every host
 * it was asked about and every endpoint it was called on, so it is the only
 * direct evidence of what this install did *not* ask for.
 */
function acmeLog(): string {
  return compose('logs', '--no-color', 'pebble')
}

/**
 * The authority's newOrder endpoint: the first request any issuance makes, and
 * the one thing it logs for *every* attempt. The identifier is not usable for
 * this — an order the authority refuses by policy is logged without ever
 * naming the host — so counting orders is what catches an attempt for a
 * second name, and the name is what says which one it was.
 */
const NEW_ORDER = '/order-plz'

/** How many certificates this install has asked the authority for, all told. */
function orderCount(log: string): number {
  return log.split(NEW_ORDER).length - 1
}

let setUp = false
let failures = 0

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures++
})

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  // The zone starts with no verification record: the first assertions below
  // are about a domain in exactly that state.
  publishZone()
  // --build: the image tag is reused, so without it the suite tests an old build.
  compose('up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  add(VERIFIED)
  add(PENDING)
  setUp = true
}, 900_000)

afterAll(() => {
  // Driven off what actually failed rather than off reaching the end of the
  // file: running one test with `-t` used to dump every container's log on a
  // clean pass. Setup failing counts, because then no test ran at all and the
  // logs are the only evidence of why.
  //
  // In a finally: the log dump itself can throw — it did, on the run before
  // the compose file existed — and a stack that outlives the suite holds 80,
  // 443 and its volumes against every run after it.
  try {
    if (failures > 0 || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
  }
}, 300_000)

describe('a domain that has not proved itself', () => {
  it('serves nothing, however the DNS was pointed', async () => {
    // The redirect has the domain and the link in its snapshot; it refuses
    // them because nobody has shown control of the name yet.
    await until(
      'the redirect to answer at all',
      60_000,
      () => curl([`http://${VERIFIED}/d`]).status === 404,
    )
    expect(curl([`http://${VERIFIED}/d`]).status).toBe(404)
  })

  it('gets no certificate, so the HTTPS handshake fails', () => {
    // -k, so this is not the client refusing to trust a certificate: there is
    // no certificate. Caddy asked the redirect, and was told no.
    const r = curl(['-k', '--max-time', '30', `https://${VERIFIED}/d`])
    // Asserted before the handshake's own result, because this is the property
    // the suite exists to be evidence for: not merely that no certificate was
    // installed, but that this install never went to a certificate authority
    // at all. That is what keeps an outsider away from its rate limits, and a
    // breach of it should be what this test reports.
    expect(acmeLog(), 'the authority was asked to issue for an unverified name').not.toContain(
      NEW_ORDER,
    )
    expect(r.status).toBe(0)
    // curl's code for a handshake that failed. Without it, the line above
    // also holds for a client that never ran at all.
    expect(r.exit, r.stderr).toBe(35)
  })
})

describe('publishing the token', () => {
  it('verifies that domain, and only that domain', async () => {
    publishZone(`_clickmonk.go IN TXT "clickmonk-verify=${tokens[VERIFIED]}"`)
    await until('the worker to verify go.example.test', 90_000, () =>
      cli('domain', 'list').includes(`${VERIFIED}: verified`),
    )
    expect(cli('domain', 'list')).toContain(`${PENDING}: unverified`)
  })

  it('makes its links answer', async () => {
    await until(
      'the redirect to serve the verified domain',
      90_000,
      () => curl([`http://${VERIFIED}/d`]).status === 302,
    )
  })

  it('gets a certificate from the certificate authority, and serves the link over HTTPS', async () => {
    await until(
      'a certificate for go.example.test',
      90_000,
      () => curl(['-k', '--max-time', '30', `https://${VERIFIED}/d`]).status === 302,
    )
    // Not -k this time. The chain really is the local authority's, which is
    // what "obtained a certificate" has to mean for this to say anything.
    const root = writeIssuingRoot()
    const r = curl(['--cacert', root, '--max-time', '30', `https://${VERIFIED}/d`], CA_MOUNT)
    expect(r.exit, r.stderr).toBe(0)
    expect(r.status).toBe(302)
  })

  it('leaves the domain that published nothing with neither', () => {
    expect(curl([`http://${PENDING}/d`]).status).toBe(404)
    const r = curl(['-k', '--max-time', '30', `https://${PENDING}/d`])
    // The sharp one, and again before the handshake's result. The authority has
    // issued for the verified host by now, so the gate is open for this
    // install — and still exactly one certificate was ever asked for, and this
    // name was never one of them. That is what makes the gate per-domain
    // rather than a switch the first verified domain throws for every host
    // pointed at the server.
    const log = acmeLog()
    expect(log, 'the authority issued nothing at all, so the next lines prove nothing').toContain(
      NEW_ORDER,
    )
    expect(orderCount(log), 'the authority was asked for a certificate it should not have').toBe(1)
    expect(log, 'the authority was asked about a name that published no token').not.toContain(
      PENDING,
    )
    expect(r.status).toBe(0)
    expect(r.exit, r.stderr).toBe(35)
  })
})

describe('the caddy healthcheck', () => {
  // A Caddy that starts, serves HTTPS and proxies nothing. Without a probe
  // that asks what Caddy is configured to do, `up --wait` calls this healthy,
  // and an install reports success over a stack that serves no link at all.
  let dir: string
  let override: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clickmonk-caddy-noproxy-'))
    const caddyfile = join(dir, 'Caddyfile')
    writeFileSync(caddyfile, ':443 {\n\ttls internal\n\trespond "no proxy" 200\n}\n')
    override = join(dir, 'compose.yml')
    // Every volume restated: Compose merges them by target path, so one left
    // out is dropped rather than kept.
    writeFileSync(
      override,
      [
        'services:',
        '  caddy:',
        '    volumes:',
        `      - "${caddyfile}:/etc/caddy/Caddyfile:ro"`,
        '      - "./test/stack/tls.d:/etc/caddy/tls.d:ro"',
        '      - "./caddy/proxy.d:/etc/caddy/proxy.d:ro"',
        '      - "./test/stack/tmp/acme-root.pem:/etc/caddy/acme-root.pem:ro"',
        '      - "caddy-data:/data"',
        '      - "caddy-config:/config"',
        '',
      ].join('\n'),
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails `up --wait` on a caddy that is serving but proxying nothing', () => {
    const failure = upWait(['caddy'], [override])
    expect(failure, '`up --wait` succeeded against a caddy that proxies nothing').toBeDefined()
    expect(failure).toContain('unhealthy')
  }, 300_000)

  it('passes on the shipped config, so it discriminates rather than always failing', async () => {
    expect(upWait(['caddy'])).toBeUndefined()
    await until(
      'caddy to serve the link again',
      120_000,
      () => curl(['-k', '--max-time', '30', `https://${VERIFIED}/d`]).status === 302,
    )
  }, 300_000)
})
