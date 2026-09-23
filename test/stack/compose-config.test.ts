import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './stack.js'

// Everything here is answered by `docker compose config`, which resolves
// interpolation without starting anything, by reading the shipped files, or
// by one short `caddy validate` run. These are the guards that have to hold
// for every install, and a guard that takes two minutes to run is a guard
// somebody skips.
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

/**
 * Just the `services:` mapping. Bounded at the next top-level key, because
 * `networks:` and `volumes:` also list two-space names underneath them and
 * would otherwise read as services.
 */
function servicesSection(cfg: string): string {
  const start = cfg.indexOf('\nservices:')
  expect(start, 'no services in the resolved configuration').toBeGreaterThan(-1)
  const after = cfg.slice(start + '\nservices:'.length)
  const end = after.search(/\n\w/)
  return end === -1 ? after : after.slice(0, end)
}

/** One service's block of the resolved configuration. */
function serviceBlock(cfg: string, service: string): string {
  const services = servicesSection(cfg)
  const start = services.indexOf(`\n  ${service}:\n`)
  expect(start, `no ${service} service in the resolved configuration`).toBeGreaterThan(-1)
  const after = services.slice(start + 1)
  const end = after.search(/\n {2}\w[\w-]*:\n/)
  return end === -1 ? after : after.slice(0, end)
}

/** Every service the resolved configuration declares. */
function serviceNames(cfg: string): string[] {
  return [...servicesSection(cfg).matchAll(/\n {2}(\w[\w-]*):\n/g)].map((m) => m[1] as string)
}

/**
 * What one service publishes in the resolved configuration, each entry as
 * `port/protocol`. The protocol is kept rather than dropped because the same
 * port number on TCP and on UDP are two different publications: `443/udp` is
 * the one an operator adds to turn HTTP/3 back on, and it must not read as a
 * change to what is published on TCP. Compose prints `protocol:` directly
 * under each `published:`.
 */
function published(cfg: string, service: string): string[] {
  return [
    ...serviceBlock(cfg, service).matchAll(/published: "?([0-9.:]+)"?\n\s*protocol: (\w+)/g),
  ].map((m) => `${m[1]}/${m[2]}`)
}

/** Just the port numbers of those, whatever protocol each is published on. */
function publishedPorts(cfg: string, service: string): string[] {
  return published(cfg, service).map((p) => p.split('/')[0] as string)
}

describe('what the stack publishes', () => {
  const cfg = config('docker-compose.yml')

  // The TCP publications exactly, so an added `443:443/udp` — the documented
  // way to turn HTTP/3 back on, pinned further down — is not read here as a
  // third port appearing. Anything else, on either protocol, still is.
  it('puts caddy on 80 and 443, and publishes nothing else', () => {
    expect(published(cfg, 'caddy').filter((p) => p.endsWith('/tcp'))).toEqual(['80/tcp', '443/tcp'])
    expect(publishedPorts(cfg, 'caddy').filter((p) => p !== '80' && p !== '443')).toEqual([])
  })

  // The redirect's internal port answers Caddy's on-demand TLS question. It
  // lists this install's verified domains to anyone who can reach it, and it
  // is the gate on certificate issuance. It belongs on the stack's own
  // network and nowhere else.
  //
  // `ports:` is not the only way onto the host's interfaces. `network_mode:
  // host` puts every port a container listens on there without a `ports:`
  // key existing anywhere, so the absence of published ports is checked
  // together with the absence of that.
  it('publishes nothing at all for the redirect, the internal port least of all', () => {
    const block = serviceBlock(cfg, 'redirect')
    expect(block, 'the redirect declares ports').not.toMatch(/\n {4}ports:/)
    expect(published(cfg, 'redirect')).toEqual([])
    expect(cfg, 'a service shares the host’s network namespace').not.toContain('network_mode')
    for (const service of serviceNames(cfg)) {
      expect(publishedPorts(cfg, service), service).not.toContain('9091')
    }
  })

  // The reason the trusted-proxy default below is safe: nothing outside can
  // reach the redirect to claim an address, because nothing but Caddy is
  // reachable at all. Driven off the resolved service list, so a service
  // added later is covered without anyone remembering to add it here.
  it('publishes nothing for any service but caddy', () => {
    const names = serviceNames(cfg)
    expect(names, 'the resolved configuration lists no services').toContain('caddy')
    expect(names.length).toBeGreaterThan(3)
    for (const service of names.filter((n) => n !== 'caddy')) {
      expect(published(cfg, service), service).toEqual([])
    }
  })

  // The admin surface must not be reachable from a link domain. Caddy routes
  // by host name, and every service that has to agree on which name that is
  // reads it from the same variable: the admin API refuses any other Host, the
  // redirect approves a certificate for that name and no other, and Caddy
  // sends that name to the admin service instead of to the redirect.
  it('gives the same admin host name to caddy, the admin API and the redirect', () => {
    const named = config('docker-compose.yml', 'CLICKMONK_ADMIN_HOST=admin.example.test\n')
    for (const service of ['caddy', 'admin', 'redirect']) {
      expect(serviceBlock(named, service), service).toContain(
        'CLICKMONK_ADMIN_HOST: admin.example.test',
      )
    }
  })

  it('starts with no admin host at all, and says nothing about one', () => {
    for (const service of ['caddy', 'admin', 'redirect']) {
      expect(serviceBlock(cfg, service), service).toMatch(/CLICKMONK_ADMIN_HOST: ""?\n/)
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
  // happens. The other direction is the same defect from the other end: a
  // variable the stack reads and nobody documents is one an operator only
  // finds by reading the compose file. So the two sets must be equal, not
  // one contained in the other — and comment lines are stripped first,
  // because `${NAME}` written in a comment is prose, not something a service
  // reads.
  it('reads exactly the variables .env.example documents, and no others', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const file = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
    const documented = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string)
    const code = file
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const read = [...code.matchAll(/\$\{([A-Z][A-Z0-9_]*)[-:?}]/g)].map((m) => m[1] as string)
    expect(documented.length).toBeGreaterThan(5)
    expect([...new Set(read)].sort()).toEqual([...new Set(documented)].sort())
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
  // the same, and the publication it does make is loopback-only. Read out of
  // the redirect's own block: ClickHouse is published on loopback here too,
  // so a whole-file match for the host address would hold with the
  // redirect's dropped.
  it('still publishes nothing on the internal port', () => {
    const block = serviceBlock(cfg, 'redirect')
    expect(published(cfg, 'redirect')).toEqual(['8080/tcp'])
    expect(block, 'the redirect is published on every interface').toContain('host_ip: 127.0.0.1')
  })
})

describe('the shipped Caddy configuration', () => {
  const caddyfile = readFileSync(join(ROOT, 'caddy', 'Caddyfile'), 'utf8')

  /** The Caddy image the stack runs, so validation cannot drift from it. */
  function caddyImage(): string {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
    const m = /^\s*image:\s*(caddy:\S+)\s*$/m.exec(compose)
    expect(m, 'no caddy image pinned in docker-compose.yml').not.toBeNull()
    return m?.[1] as string
  }

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
  // found before the newline: `[^{]*` would run past the end of a brace-less
  // `reverse_proxy` into the next one that does have a block, and read an
  // import a level too high as if it were in place.
  //
  // Every `reverse_proxy` is checked, not the first: the sites are configured
  // separately, and one of them losing the import is the whole defect. So the
  // count of blocks has to equal the count of directives, and each block has
  // to carry the glob.
  it('imports the override directories from the blocks their directives belong in', () => {
    const tls = /\n\ttls \{([^}]*)\}/s.exec(caddyfile)
    expect(tls?.[1], 'no tls block opening on its own line').toContain('/etc/caddy/tls.d/*.caddy')

    const directives = [...caddyfile.matchAll(/^[ \t]*reverse_proxy\b/gm)]
    const blocks = [...caddyfile.matchAll(/reverse_proxy[^\n{]*\{([^}]*)\}/g)]
    // Three: the admin API and the redirect on :443, and the redirect on :80.
    expect(
      directives.length,
      'a reverse_proxy per handler: admin and redirect on :443, redirect on :80',
    ).toBe(3)
    expect(blocks.length, 'a reverse_proxy that opens no block of its own').toBe(directives.length)
    for (const [i, block] of blocks.entries()) {
      expect(block[1], `reverse_proxy block ${i + 1} imports nothing`).toContain(
        '/etc/caddy/proxy.d/*.caddy',
      )
    }
  })

  // HTTP/3 is reached over UDP, and the stack publishes 443 as TCP alone, so
  // an install that advertised HTTP/3 would be pointing clients at a port the
  // host never forwards. The two settings only make sense together, which is
  // what this asserts: h3 is served exactly when a UDP port is published.
  // Read as one equality rather than as two separate checks, so it fails from
  // either side — the protocols line quietly disappearing (Caddy's own
  // default serves h3), and a UDP port published without h3 being put back.
  it('serves HTTP/3 exactly when the stack publishes a UDP port', () => {
    const udp = serviceBlock(config('docker-compose.yml'), 'caddy').includes('protocol: udp')
    const line = /^[ \t]*protocols[ \t]+(.*)$/m.exec(caddyfile)?.[1]
    // No line at all is Caddy's default, which is h1 h2 h3.
    const protocols = (line ?? 'h1 h2 h3').trim().split(/\s+/)
    expect(
      protocols.includes('h3'),
      `protocols ${protocols.join(' ')} with 443/udp ${udp ? '' : 'not '}published`,
    ).toBe(udp)
  })

  it('ships a file in each, so the glob is never empty', () => {
    for (const d of ['tls.d', 'proxy.d']) {
      const files = readdirSync(join(ROOT, 'caddy', d)).filter((f) => f.endsWith('.caddy'))
      expect(files.length, d).toBeGreaterThan(0)
    }
  })

  // Every other test here reads a file back to itself. This one asks Caddy,
  // in the version the stack runs, whether it would start on this
  // configuration — which catches a misplaced directive, a typo and a block
  // nested where Caddy does not accept it, none of which a regular expression
  // over the text would notice. `--network none` because no test in this
  // suite reaches a network, and `--rm` because none leaves a container
  // behind.
  //
  // Three runs, and the middle one is the one that matters. Caddy's
  // `{$VAR:default}` only falls back when the variable is UNSET; Compose sets
  // CLICKMONK_ADMIN_HOST to the empty string for every install that did not
  // name a host, and an empty `host` matcher value is fatal at boot as well as
  // here. This is the guard on the default install starting at all.
  it.each([
    ['unset', undefined],
    ['set to the empty string, as the default install leaves it', ''],
    ['set to a host name', 'admin.example.test'],
  ])(
    'is a configuration Caddy itself accepts, with CLICKMONK_ADMIN_HOST %s',
    (_label, value: string | undefined) => {
      const r = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          ...(value === undefined ? [] : ['-e', `CLICKMONK_ADMIN_HOST=${value}`]),
          '-v',
          `${join(ROOT, 'caddy')}:/etc/caddy:ro`,
          caddyImage(),
          'caddy',
          'validate',
          '--adapter',
          'caddyfile',
          '--config',
          '/etc/caddy/Caddyfile',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      )
      // Docker's own failure to run is not a valid configuration. Without this
      // a missing image reads as a passing check.
      expect(r.error?.message, 'could not run caddy').toBeUndefined()
      expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0)
      expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('Valid configuration')
    },
  )

  // A named site block would make Caddy try to obtain a certificate for that
  // name at boot; on an install with no admin host that is a certificate for
  // nothing, and with an unset variable it is a parse error that crash-loops.
  // Both site addresses are therefore ports, and the admin host is a matcher.
  it('routes the admin API by host name, from a port-only site address', () => {
    expect(caddyfile).toMatch(/^:443 \{$/m)
    expect(caddyfile).toMatch(/^:80 \{$/m)
    const matchers = [...caddyfile.matchAll(/^\s*@admin (\S+) (.*)$/gm)]
    expect(matchers.length, 'an @admin matcher on each site block').toBe(2)
    for (const m of matchers) {
      // Never `host {$CLICKMONK_ADMIN_HOST…}`: Compose sets that variable to
      // the empty string on a default install, and Caddy refuses an empty
      // `host` value at boot. The expression form is empty-safe, which the
      // validate rows above prove rather than assert.
      expect(m[1], 'the admin matcher must not be a bare host matcher').toBe('expression')
      expect(m[2]).toContain('{env.CLICKMONK_ADMIN_HOST} != ""')
      expect(m[2]).toContain('host({env.CLICKMONK_ADMIN_HOST})')
    }
    expect(caddyfile).toContain('reverse_proxy admin:9100')
  })

  // The admin session cookie is Secure, so a browser drops it over plain
  // HTTP: signing in would appear to work and then not.
  it('sends the admin host to HTTPS on port 80 rather than proxying it', () => {
    const plain = /\n:80 \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? ''
    expect(plain).toContain('redir https://{host}{uri} 308')
    expect(plain).not.toContain('admin:9100')
  })

  // Anything but a commented-out example activates the directive in every
  // install that takes this file as shipped. And an argument that covers
  // ranges the operator does not actually sit behind is the same as no check
  // at all: `private_ranges` believes any container or LAN peer,
  // `0.0.0.0/0` and `::/0` believe everyone, and `static` belongs to Caddy's
  // *global* `servers { trusted_proxies static … }` option one level up —
  // written here it is read as an address and Caddy exits at boot.
  it('shows no trusted_proxies directive that is live or trusts too much', () => {
    const forbidden = ['static', 'private_ranges', '0.0.0.0/0', '::/0']
    const defaults = readFileSync(join(ROOT, 'caddy', 'proxy.d', '00-defaults.caddy'), 'utf8')
    const mentions = defaults.split('\n').filter((l) => l.includes('trusted_proxies'))
    expect(mentions.length, 'the file explains trusted_proxies nowhere').toBeGreaterThan(0)
    let examples = 0
    for (const line of mentions) {
      expect(line.trimStart().startsWith('#'), `a live trusted_proxies directive: ${line}`).toBe(
        true,
      )
      const args = (/trusted_proxies[^\S\n]+(.*)$/.exec(line)?.[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      if (args.length > 0) examples++
      for (const a of args) expect(forbidden, line).not.toContain(a)
    }
    expect(examples, 'the file shows no example of naming a CDN’s ranges').toBeGreaterThan(0)
  })
})
