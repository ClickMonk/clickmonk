import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CA_MOUNT,
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

let passed = false

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  // The zone starts with no verification record: the first assertions below
  // are about a domain in exactly that state.
  publishZone()
  // --build: the image tag is reused, so without it the suite tests an old build.
  compose('up', '-d', '--build', '--wait')
  add(VERIFIED)
  add(PENDING)
}, 900_000)

afterAll(() => {
  // In a finally: the log dump itself can throw — it did, on the run before
  // the compose file existed — and a stack that outlives the suite holds 80,
  // 443 and its volumes against every run after it.
  try {
    if (!passed) console.error(compose('logs', '--no-color', '--tail', '200'))
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
    expect(r.status).toBe(0)
    // curl's code for a handshake that failed. Without it, the line above
    // also holds for a client that never ran at all.
    expect(r.exit, r.stderr).toBe(35)
  })
})

describe('publishing the token', () => {
  it('verifies that domain, and only that domain', async () => {
    publishZone(`_clickmonk.go IN TXT "clickmonk-verify=${tokens[VERIFIED]}"`)
    await until('the worker to verify go.example.test', 180_000, () =>
      cli('domain', 'list').includes(`${VERIFIED}: verified`),
    )
    expect(cli('domain', 'list')).toContain(`${PENDING}: unverified`)
  })

  it('makes its links answer', async () => {
    await until(
      'the redirect to serve the verified domain',
      120_000,
      () => curl([`http://${VERIFIED}/d`]).status === 302,
    )
  })

  it('gets a certificate from the certificate authority, and serves the link over HTTPS', async () => {
    await until(
      'a certificate for go.example.test',
      180_000,
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
    // The last line of the last test in the file, so that a failure anywhere
    // above — the healthcheck pair included, where Caddy's own log is the
    // only evidence — still leaves the containers' logs in the output.
    passed = true
  }, 300_000)
})
