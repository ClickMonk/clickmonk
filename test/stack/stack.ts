import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The repository root: every compose path below is relative to it. */
export const ROOT = join(import.meta.dirname, '..', '..')
/** Scratch the suite writes and the stack mounts. Git-ignored. */
export const TMP = join(ROOT, 'test', 'stack', 'tmp')
/** The network Compose builds for this project; a client container joins it. */
export const NETWORK = 'clickmonk-tls_default'
export const CURL_IMAGE = 'curlimages/curl:8.11.1'
export const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.10.1'

const FILES = ['-f', 'docker-compose.yml', '-f', 'test/stack/docker-compose.tls.yml']

/**
 * Seconds `up --wait` may spend waiting for containers to become healthy.
 * Compose waits forever without it, so a container stuck starting hangs the
 * suite until the whole run is killed and prints nothing to say why. Well
 * above the ~70s an unhealthy verdict takes, which is a result this suite
 * asserts rather than a hang.
 */
export const WAIT_TIMEOUT = ['--wait-timeout', '240']

/**
 * Backstops for the synchronous docker calls below, in milliseconds. Each is
 * far above what the call takes when it works; they exist so that a stalled
 * pull, a hung daemon or a container that never starts fails with a
 * diagnostic instead of hanging the suite.
 */
const COMPOSE_TIMEOUT = 600_000
const UP_TIMEOUT = 270_000
const CLIENT_TIMEOUT = 60_000

/** The stack's own passwords. Public, for a stack that binds nothing but 80 and 443. */
export const ENV = {
  ...process.env,
  POSTGRES_PASSWORD: 'tlstest',
  CLICKHOUSE_PASSWORD: 'tlstest',
  CLICKMONK_SECRET: 'tls-suite-secret-tls-suite-secret-tls',
}

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...FILES, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: ENV,
    timeout: COMPOSE_TIMEOUT,
  })
}

/**
 * `up -d --wait`, returning what it printed when it failed and `undefined`
 * when it worked. A thrown error would hide the reason, and the reason —
 * "container … is unhealthy" — is the assertion in the healthcheck tests.
 */
export function upWait(services: string[] = [], extraFiles: string[] = []): string | undefined {
  const args = [
    'compose',
    ...FILES,
    ...extraFiles.flatMap((f) => ['-f', f]),
    'up',
    '-d',
    '--wait',
    ...WAIT_TIMEOUT,
    ...services,
  ]
  const r = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: ENV,
    timeout: UP_TIMEOUT,
  })
  // Docker failing to run at all, or being killed by the backstop above, is
  // not "compose said no". Without this it returns whatever it managed to
  // print, and a caller asserting on the reason reads a hang as that reason.
  if (r.error) throw new Error(`could not run compose up: ${r.error.message}`)
  if (r.status === 0) return undefined
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/** The CLI, inside the worker container, where the configuration variables are. */
export function cli(...args: string[]): string {
  return compose('exec', '-T', 'worker', 'node', 'packages/cli/dist/index.js', ...args)
}

export interface CurlResult {
  /** The HTTP status, or 0 when the request never got one (a refused handshake, a timeout). */
  status: number
  /** curl's own exit code: 0 success, 35 a TLS handshake that failed, 7 nothing listening. */
  exit: number
  /** The address the client used, which is what the redirect should record. */
  ip: string
  /**
   * The response headers, when the call asked for them with `-D -`; empty
   * otherwise. The body goes to /dev/null below, so `-D -` has stdout to
   * itself and the write-out line is the last line of it.
   */
  headers: string
  stderr: string
}

/**
 * curl from a container on the stack's own network, so the address the
 * redirect records is a real client's rather than anything Docker rewrote on
 * the way through a published port.
 */
export function curl(args: string[], docker: string[] = []): CurlResult {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      NETWORK,
      ...docker,
      CURL_IMAGE,
      '-sS',
      '-o',
      '/dev/null',
      // On its own line, so a call that also asked for the headers with
      // `-D -` does not have them run into the two values parsed below.
      '-w',
      '\\n%{http_code} %{local_ip}',
      ...args,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: CLIENT_TIMEOUT },
  )
  // 125 is docker's own failure, not the client's. Without this a missing
  // image or a network that is not there reads as "the server refused",
  // which is what several assertions are looking for: they would pass on
  // nothing having happened.
  if (r.error || r.status === 125) {
    throw new Error(`could not run the client: ${r.error?.message ?? ''} ${r.stderr ?? ''}`)
  }
  const out = (r.stdout ?? '').replace(/\r\n/g, '\n')
  const nl = out.lastIndexOf('\n')
  const [code = '0', ip = ''] = out
    .slice(nl + 1)
    .trim()
    .split(' ')
  return {
    status: Number(code),
    exit: r.status ?? -1,
    ip,
    headers: nl === -1 ? '' : out.slice(0, nl),
    stderr: r.stderr ?? '',
  }
}

/**
 * The one file in a tar stream: a 512-byte ustar header whose size field is
 * octal, then that many bytes. Enough to unpack one known file, and not a tar
 * reader.
 */
function oneFileFromTar(tar: Buffer): Buffer {
  const field = tar
    .toString('ascii', 124, 136)
    .replace(/\0[\s\S]*$/, '')
    .trim()
  const size = Number.parseInt(field, 8)
  if (!Number.isInteger(size) || size <= 0 || 512 + size > tar.length) {
    throw new Error(`docker cp returned an archive this cannot read: size field ${field}`)
  }
  return tar.subarray(512, 512 + size)
}

/**
 * The local ACME server's own HTTPS certificate, which Caddy has to trust
 * before it can talk to it at all. Taken out of the image with
 * `docker create` + `docker cp`, because the image has no shell to cat it.
 *
 * `docker cp … -` writes a tar to stdout and node unpacks it, rather than
 * letting `docker cp <path>` create the file: the Docker CLI preserves the
 * archive's ownership when it runs as root, and a root-owned file here is one
 * a later non-root run of these suites can neither read nor replace.
 */
export function writeAcmeRoot(): void {
  mkdirSync(TMP, { recursive: true })
  const id = execFileSync('docker', ['create', PEBBLE_IMAGE], {
    encoding: 'utf8',
    timeout: CLIENT_TIMEOUT,
  }).trim()
  let tar: Buffer
  try {
    tar = execFileSync('docker', ['cp', `${id}:/test/certs/pebble.minica.pem`, '-'], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: CLIENT_TIMEOUT,
    })
  } finally {
    execFileSync('docker', ['rm', id], { stdio: 'ignore', timeout: CLIENT_TIMEOUT })
  }
  const pem = oneFileFromTar(tar).toString('utf8')
  if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`the image holds no certificate at that path: ${pem.slice(0, 200)}`)
  }
  const path = join(TMP, 'acme-root.pem')
  // A file an earlier run left owned by root, from when the Docker CLI wrote
  // it: writing over it would fail, removing it needs only this directory.
  rmSync(path, { force: true })
  writeFileSync(path, pem, { mode: 0o644 })
}

/**
 * Writes the root the local ACME server issues from — new on every start of
 * it — into the directory the stack already mounts, and returns the path a
 * client container sees it at. Written there rather than into a fresh
 * temporary directory because `mkdtemp` makes one only its owner can enter,
 * and the client image does not run as root.
 */
export function writeIssuingRoot(): string {
  mkdirSync(TMP, { recursive: true })
  const pem = execFileSync(
    'docker',
    ['run', '--rm', '--network', NETWORK, CURL_IMAGE, '-sS', '-k', 'https://pebble:15000/roots/0'],
    { encoding: 'utf8', timeout: CLIENT_TIMEOUT },
  )
  if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`the local certificate authority returned no root: ${pem.slice(0, 200)}`)
  }
  writeFileSync(join(TMP, 'issuing-root.pem'), pem, { mode: 0o644 })
  return '/ca/issuing-root.pem'
}

/** Mount arguments that put the suite's scratch directory at /ca in a client container. */
export const CA_MOUNT = ['-v', `${TMP}:/ca:ro`]

let serial = 1

/**
 * Rewrites the test zone. The serial has to go up or the DNS server keeps
 * serving the file it already parsed, however often it re-reads it.
 */
export function publishZone(...records: string[]): void {
  mkdirSync(join(TMP, 'zones'), { recursive: true })
  serial++
  writeFileSync(
    join(TMP, 'zones', 'db.example.test'),
    [
      '$TTL 1',
      `@ IN SOA ns.example.test. admin.example.test. ${serial} 60 60 60 1`,
      '@ IN NS ns.example.test.',
      'ns IN A 192.0.2.1',
      ...records,
      '',
    ].join('\n'),
  )
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `check` is true, or throws with `what` after `ms`. */
export async function until(
  what: string,
  ms: number,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`)
    await sleep(500)
  }
}
