import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './stack.js'

// Everything here is answered by `docker compose config`, which resolves
// interpolation without starting anything, or by reading the shipped files.
// These are the guards that have to hold for every install, and a guard that
// takes two minutes to run is a guard somebody skips.
//
// An explicit --env-file, never the repository's own .env: a machine that has
// one would otherwise make this suite pass or fail on whose machine it ran.
function config(file: string, env = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'clickmonk-compose-'))
  const envFile = join(dir, 'env')
  writeFileSync(
    envFile,
    `POSTGRES_PASSWORD=x\nCLICKHOUSE_PASSWORD=y\nCLICKMONK_SECRET=${'z'.repeat(40)}\n${env}`,
  )
  try {
    return execFileSync(
      'docker',
      ['compose', '--env-file', envFile, '--project-directory', '.', '-f', file, 'config'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The `published:` lines of one service block in the resolved configuration. */
function published(cfg: string, service: string): string[] {
  const services = cfg.slice(cfg.indexOf('\nservices:'))
  const start = services.indexOf(`\n  ${service}:`)
  expect(start, `no ${service} service in the resolved configuration`).toBeGreaterThan(-1)
  const after = services.slice(start + 1)
  const end = after.search(/\n {2}\w[\w-]*:\n/)
  const block = end === -1 ? after : after.slice(0, end)
  return [...block.matchAll(/published: "?([0-9.:]+)"?/g)].map((m) => m[1] as string)
}

describe('what the stack publishes', () => {
  const cfg = config('docker-compose.yml')

  it('puts caddy on 80 and 443', () => {
    expect(published(cfg, 'caddy')).toEqual(['80', '443'])
  })

  // The redirect's internal port answers Caddy's on-demand TLS question. It
  // lists this install's verified domains to anyone who can reach it, and it
  // is the gate on certificate issuance. It belongs on the stack's own
  // network and nowhere else.
  it('publishes nothing at all for the redirect, the internal port least of all', () => {
    expect(published(cfg, 'redirect')).toEqual([])
    for (const service of ['caddy', 'worker', 'postgres', 'clickhouse']) {
      expect(published(cfg, service), service).not.toContain('9091')
    }
  })

  it('tells the redirect to believe a forwarded address only from the stack’s own network', () => {
    expect(cfg).toContain('CLICKMONK_TRUSTED_PROXIES: uniquelocal,loopback')
  })

  it('lets an operator narrow that, and an IPv6 subnet that collides', () => {
    const narrowed = config('docker-compose.yml', 'CLICKMONK_TRUSTED_PROXIES=172.31.0.0/16\n')
    expect(narrowed).toContain('CLICKMONK_TRUSTED_PROXIES: 172.31.0.0/16')
    const moved = config('docker-compose.yml', 'CLICKMONK_IPV6_SUBNET=fd00:dead:1::/64\n')
    expect(moved).toContain('fd00:dead:1::/64')
  })

  // Without it, Docker relays IPv6 connections through its own userland proxy
  // and every IPv6 visitor arrives as the bridge gateway.
  it('gives the stack an IPv6 network', () => {
    expect(cfg).toMatch(/enable_ipv6: true/)
  })

  // Compose substitutes only the variables the compose file itself names. A
  // setting documented in .env.example that no service reads is not a small
  // documentation slip: the operator sets it, nothing fails, and nothing
  // happens. Read from the file rather than listed here, so the next variable
  // added to .env.example is covered without anyone remembering to.
  it('reads every variable .env.example documents', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const file = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
    const documented = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string)
    expect(documented.length).toBeGreaterThan(5)
    for (const name of documented) {
      expect(file, name).toContain(`\${${name}`)
    }
  })

  // A warning on every `up`, `ps` and `exec` is the first thing that makes
  // an install look broken. Compose puts them on stderr, which the helper
  // above — it returns stdout — could never have caught.
  it('gives Compose no unset variable to warn about', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clickmonk-compose-warn-'))
    const envFile = join(dir, 'env')
    writeFileSync(
      envFile,
      `POSTGRES_PASSWORD=x\nCLICKHOUSE_PASSWORD=y\nCLICKMONK_SECRET=${'z'.repeat(40)}\n`,
    )
    try {
      const r = spawnSync(
        'docker',
        [
          'compose',
          '--env-file',
          envFile,
          '--project-directory',
          '.',
          '-f',
          'docker-compose.yml',
          'config',
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      )
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).not.toContain('variable is not set')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the restart-durability stack', () => {
  const cfg = config('docker-compose.ci.yml')

  it('asks no DNS questions, so the suite needs no resolver', () => {
    expect(cfg).toContain('CLICKMONK_DNS_CHECK: "off"')
  })

  // It publishes the redirect, which the shipped stack does not: its client
  // talks to the redirect directly. The internal port stays unpublished all
  // the same, and the publication it does make is loopback-only.
  it('still publishes nothing on the internal port', () => {
    expect(published(cfg, 'redirect')).toEqual(['8080'])
    expect(cfg).toContain('host_ip: 127.0.0.1')
  })
})

describe('the shipped Caddy configuration', () => {
  const caddyfile = readFileSync(join(ROOT, 'caddy', 'Caddyfile'), 'utf8')

  it('asks the redirect before obtaining any certificate', () => {
    // The whole of the gate: without this line Caddy obtains a certificate
    // for any host name pointed at the server.
    expect(caddyfile).toMatch(/on_demand_tls\s*\{[^}]*ask\s+http:\/\/redirect:9091\/ask/s)
  })

  it('turns on-demand issuance on inside the tls block, where it belongs', () => {
    const tls = /\n\ttls \{([^}]*)\}/s.exec(caddyfile)
    expect(tls, 'no tls block in the Caddyfile').not.toBeNull()
    expect(tls?.[1]).toContain('on_demand')
  })

  // A block opens on the directive's own line, so the opening brace has to be
  // found before the newline. `[^{]*` would run past the end of a
  // brace-less `reverse_proxy` into the next block that does have one, and
  // then read an import that is a level too high as if it were in place.
  it('imports the override directories from the blocks their directives belong in', () => {
    const tls = /\n\ttls \{([^}]*)\}/s.exec(caddyfile)
    expect(tls?.[1], 'no tls block opening on its own line').toContain('/etc/caddy/tls.d/*.caddy')
    const proxy = /reverse_proxy[^\n{]*\{([^}]*)\}/.exec(caddyfile)
    expect(proxy?.[1], 'no reverse_proxy block opening on its own line').toContain(
      '/etc/caddy/proxy.d/*.caddy',
    )
  })

  it('ships a file in each, so the glob is never empty', () => {
    for (const d of ['tls.d', 'proxy.d']) {
      const files = readdirSync(join(ROOT, 'caddy', d)).filter((f) => f.endsWith('.caddy'))
      expect(files.length, d).toBeGreaterThan(0)
    }
  })

  // `trusted_proxies 0.0.0.0/0` inside reverse_proxy trusts every client to
  // name its own address, which is the same as no check at all; and `static`
  // belongs to Caddy's global option one level up, where this file's examples
  // do not land.
  it('never shows a trusted_proxies example that would undo the check', () => {
    const defaults = readFileSync(join(ROOT, 'caddy', 'proxy.d', '00-defaults.caddy'), 'utf8')
    const examples = [...defaults.matchAll(/trusted_proxies\s+(\S+)/g)].map((m) => m[1] as string)
    expect(examples.length).toBeGreaterThan(0)
    for (const e of examples) {
      expect(e).not.toBe('static')
      expect(e).not.toBe('0.0.0.0/0')
      expect(e).not.toBe('::/0')
    }
  })
})
