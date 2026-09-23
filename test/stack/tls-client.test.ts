import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CURL_IMAGE,
  ENV,
  NETWORK,
  ROOT,
  WAIT_TIMEOUT,
  cli,
  compose,
  curl,
  publishZone,
  until,
  writeAcmeRoot,
} from './stack.js'

const HOST = 'go.example.test'

/**
 * The eight hextets of an IPv6 address. One address has many spellings —
 * `fd00:c11c:7::9`, `fd00:c11c:0007:0:0:0:0:9` — so a subnet comparison has to
 * be arithmetic; a string prefix would call an equivalent subnet a different
 * one and report a red that says nothing about the stack.
 */
function hextets(address: string): number[] {
  const [head = '', tail = ''] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = !address.includes('::') || tail === '' ? [] : tail.split(':')
  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  const out = parts.map((p) => Number.parseInt(p, 16))
  if (out.length !== 8 || out.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    throw new Error(`not an IPv6 address: ${address}`)
  }
  return out
}

/**
 * The unique-local subnet this stack's own network is given, read from the
 * file that gives it rather than written out a second time here. An IPv6
 * client container's address has to be inside it: that is what makes "the
 * address the redirect recorded is the client's" an assertion about this
 * stack, rather than about whatever address the machine happened to have.
 */
const ULA = ((): { subnet: string; network: number[]; bits: number } => {
  const yml = readFileSync(join(ROOT, 'test', 'stack', 'docker-compose.tls.yml'), 'utf8')
  const m = /subnet: (fd[0-9a-f:]+)\/(\d+)/.exec(yml)
  if (!m) throw new Error('the test stack defines no unique-local IPv6 subnet')
  const address = m[1] as string
  const bits = Number(m[2])
  return { subnet: `${address}/${bits}`, network: hextets(address), bits }
})()

/** Whether an address is inside the subnet the stack's compose file defines. */
function onStackNetwork(address: string): boolean {
  const a = hextets(address)
  const whole = Math.floor(ULA.bits / 16)
  for (let i = 0; i < whole; i++) if (a[i] !== ULA.network[i]) return false
  const rest = ULA.bits % 16
  if (rest === 0) return true
  const mask = 0xffff << (16 - rest)
  return ((a[whole] ?? 0) & mask) === ((ULA.network[whole] ?? 0) & mask)
}

/** One column of the clicks this stack has shipped, a row per line. */
function query(select: string): string[] {
  const out = compose(
    'exec',
    '-T',
    'clickhouse',
    'clickhouse-client',
    '--user',
    'clickmonk',
    '--password',
    ENV.CLICKHOUSE_PASSWORD as string,
    '-d',
    'clickmonk',
    '-q',
    `${select} FORMAT TSV`,
  )
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * What the redirect recorded, once the worker has shipped it. `path` scopes
 * the answer to one link, which is how each test below reads back its own
 * request rather than any request: Docker hands a fresh client container the
 * address the last one just released, so "some click from this address" is a
 * question an earlier test's click already answers.
 */
function recordedAddresses(path?: string): string[] {
  const scope = path === undefined ? '' : ` AND path = '${path}'`
  // Grouped and ordered: the clicks table is a ReplacingMergeTree, so a
  // re-shipped segment leaves two rows per click until a merge ClickHouse
  // times itself collapses them, and an unordered result makes an equality
  // assertion fail on the order rows came back in.
  return query(`SELECT ip FROM clicks WHERE host = '${HOST}'${scope} GROUP BY ip ORDER BY ip`)
}

/** How many clicks one link has, counted so that a re-shipped segment is not two. */
function recordedClicks(path: string): number {
  const [n] = query(
    `SELECT count(DISTINCT click_id) FROM clicks WHERE host = '${HOST}' AND path = '${path}'`,
  )
  return Number(n ?? 0)
}

/**
 * Bounded well under this config's own per-test timeout, so that a click that
 * never arrives is reported as the address it was waiting for rather than as a
 * generic timeout. A click reaches ClickHouse in about five seconds: the
 * redirect seals a segment after two, and the worker ships every one.
 */
const waitForAddress = (ip: string, path?: string) =>
  until(`the click from ${ip} to reach ClickHouse`, 60_000, () =>
    recordedAddresses(path).includes(ip),
  )

/** Waits for `n` clicks on one link to arrive, whatever they were recorded as. */
const waitForClicks = (path: string, n = 1) =>
  until(`${n} click(s) on ${path} to reach ClickHouse`, 60_000, () => recordedClicks(path) >= n)

/**
 * This host's own address, which is what an outside visitor would arrive
 * from. Docker's own bridges are refused rather than returned: a connection
 * from `docker0`'s gateway to a published port takes a different path from a
 * visitor's, so returning one would make the tests below claim more than they
 * proved — and which interface this returns is not otherwise deterministic.
 * Refusing loudly is the point: silently testing something weaker is the
 * failure this guards against.
 */
function hostAddress(family: 'IPv4' | 'IPv6'): string | null {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue
    for (const n of list ?? []) {
      if (n.family !== family || n.internal) continue
      // A link-local address is not one a client can be pointed at without
      // also naming the interface it is on, and `--resolve` has nowhere to put
      // that. Skipped rather than refused: the interface usually carries a
      // routable address as well, and that is the one to use.
      if (/^fe80:/i.test(n.address)) continue
      // 172.16.0.0/12 is where Docker puts its own bridges. An interface that
      // is not named like one but carries an address from that range is not
      // something to guess about.
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(n.address)) {
        throw new Error(
          `${name} carries ${n.address}, a Docker bridge range: this host has no address a visitor could arrive from`,
        )
      }
      return n.address
    }
  }
  return null
}

let setUp = false
let failures = 0

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures++
})

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  publishZone()
  compose('up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  // Verified without a DNS check: this suite is about addresses, not about
  // how a domain proves itself.
  cli('domain', 'add', HOST, '--verified')
  // A link per case below, so that each test reads back the click it made.
  for (const slug of ['d', 'v4', 'v6', 'claimed', 'p4', 'p6', 'again']) {
    cli('link', 'add', HOST, slug, '--target', 'https://example.com/landing')
  }
  await until(
    'the redirect to serve the link',
    60_000,
    () => curl([`http://${HOST}/d`]).status === 302,
  )
  await until(
    'a certificate for the domain',
    90_000,
    () => curl(['-k', '--max-time', '30', `https://${HOST}/d`]).status === 302,
  )
  setUp = true
}, 900_000)

afterAll(() => {
  // Driven off what failed rather than off reaching the end of the file, so a
  // run filtered to one test does not dump every container's log on a clean
  // pass. Setup failing counts: no test ran at all then, and the logs are the
  // only evidence of why. In a finally, because the dump itself can throw and
  // a stack that outlives the suite holds 80, 443 and its volumes against
  // every run after it.
  try {
    if (failures > 0 || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
  }
}, 300_000)

describe('the address the redirect records', () => {
  it('is the IPv4 client’s, not the proxy’s', async () => {
    const r = curl(['-4', '-k', `https://${HOST}/v4`])
    expect(r.status).toBe(302)
    expect(r.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    await waitForAddress(r.ip, '/v4')
    // Only that address: one client made this link's only click, so anything
    // else recorded against it is an address the redirect invented.
    expect(recordedAddresses('/v4')).toEqual([r.ip])
  })

  it('is the IPv6 client’s, each visitor told apart', async () => {
    const r = curl(['-6', '-k', `https://${HOST}/v6`])
    expect(r.status).toBe(302)
    // On the subnet this stack's compose file defines, not merely "has a
    // colon in it": the bridge gateway's address has a colon too, and that is
    // the address this whole suite exists to tell apart from a visitor's.
    expect(onStackNetwork(r.ip), `${r.ip} is not on the stack's own ${ULA.subnet} network`).toBe(
      true,
    )
    await waitForAddress(r.ip, '/v6')
    expect(recordedAddresses('/v6')).toEqual([r.ip])
  })

  it('is the client’s own, not an address the client claimed', async () => {
    const forged = '203.0.113.9'
    const r = curl(['-4', '-k', '-H', `X-Forwarded-For: ${forged}`, `https://${HOST}/claimed`])
    expect(r.status).toBe(302)
    // Waits for this click by its link rather than by the address it should
    // have, and then reads the address back: waiting for the client's own
    // address would be satisfied by an earlier test's click from the same
    // reused container address, and the claim would never be looked at.
    await waitForClicks('/claimed')
    expect(recordedAddresses('/claimed')).toEqual([r.ip])
    expect(recordedAddresses()).not.toContain(forged)
  })
})

describe('a visitor arriving on the published port', () => {
  // Not loopback: Docker relays a connection to 127.0.0.1 or ::1 through its
  // own proxy, and the address the container sees is then the bridge
  // gateway's. A visitor from outside never arrives that way, and neither
  // does this test.
  //
  // Caught rather than allowed to throw here: a throw in a describe body is a
  // collection error that takes the whole file down, and a host with nothing
  // but a Docker bridge address would then also silence the forged-header and
  // cookie guards, which have nothing to do with this host's interfaces. The
  // refusal is rethrown inside each of the two tests it belongs to instead:
  // loud, and local to them.
  const host = ((): { v4: string | null; v6: string | null; refused?: unknown } => {
    try {
      return { v4: hostAddress('IPv4'), v6: hostAddress('IPv6') }
    } catch (refused) {
      return { v4: null, v6: null, refused }
    }
  })()

  const throughPort = (address: string, path: string): number => {
    const r = spawnSync(
      'curl',
      [
        '-sS',
        '-k',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '30',
        '--resolve',
        `${HOST}:443:${address}`,
        `https://${HOST}${path}`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    if (r.error) throw r.error
    return Number((r.stdout ?? '').trim())
  }

  it('keeps its IPv4 address', async () => {
    if (host.refused) throw host.refused
    if (!host.v4) throw new Error('this host has no non-loopback IPv4 address')
    expect(throughPort(host.v4, '/p4')).toBe(302)
    await waitForAddress(host.v4, '/p4')
    expect(recordedAddresses('/p4')).toEqual([host.v4])
  })

  // Skipped where the host has no IPv6 address of its own — a hosted CI
  // runner usually has none — and run by hand before a release. A host whose
  // only IPv6 address is unique-local exercises the same path; a globally
  // routable one is the case nothing here can arrange. A refused address is
  // not "no address": that case runs and reports the refusal.
  it.skipIf(!host.refused && !host.v6)('keeps its IPv6 address', async () => {
    if (host.refused) throw host.refused
    const v6 = host.v6 as string
    expect(throughPort(v6, '/p6')).toBe(302)
    await waitForAddress(v6, '/p6')
    expect(recordedAddresses('/p6')).toEqual([v6])
  })
})

describe('a returning visitor over HTTPS', () => {
  it('is given a cookie and recognised by it', async () => {
    // The visitor cookies are Secure, so this is the first release in which
    // any of this can happen at all.
    const out = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        NETWORK,
        CURL_IMAGE,
        'sh',
        '-c',
        [
          `curl -sS -k -c /tmp/j -o /dev/null https://${HOST}/again`,
          `curl -sS -k -b /tmp/j -c /tmp/j -o /dev/null -w '%{http_code}' https://${HOST}/again`,
          'echo " $(grep -c cm_ /tmp/j)"',
        ].join(' && '),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    ).trim()
    const [status, cookies] = out.split(' ')
    expect(status).toBe('302')
    // cm_vid and cm_seen: the visitor's id, and the links this visitor has
    // clicked on this domain.
    expect(Number(cookies)).toBe(2)
    // Recognised, and not merely given cookies twice: the second click carries
    // the returning flag the redirect reads off the cookie the first one set.
    // Without this the test holds for a server that mints a new visitor on
    // every request.
    await waitForClicks('/again', 2)
    // In the order the visits happened, not sorted: sorting by the flag passes
    // for a server that recorded the second visit first. One row per click,
    // because a re-shipped segment holds each of them twice.
    expect(
      query(
        `SELECT any(returning) FROM clicks WHERE host = '${HOST}' AND path = '/again' GROUP BY click_id ORDER BY min(time)`,
      ),
    ).toEqual(['0', '1'])
  })
})
