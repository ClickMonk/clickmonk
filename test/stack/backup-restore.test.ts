import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_HOST,
  CA_MOUNT,
  type CurlResult,
  ENV,
  ROOT,
  TMP,
  WAIT_TIMEOUT,
  cli,
  cliWithInput,
  compose,
  curl,
  publishZone,
  until,
  writeAcmeRoot,
  writeIssuingRoot,
} from './stack.js'

/**
 * backup.sh and restore.sh, run as an operator runs them, against the shipped
 * stack: plain `docker compose` selected by COMPOSE_FILE, and the stack's
 * variables in the file COMPOSE_ENV_FILES names — never this repository's own
 * .env, which is not this suite's to read or write.
 *
 * One stack serves the backup tests and the refusals, which change nothing.
 * The round trip at the end takes a backup, destroys every volume, starts an
 * empty stack and restores into it.
 */
const EMAIL = 'admin@example.com'
const PASSWORD = 'a decent admin password'
const LINK_HOST = 'bak.example.test'
const SLUG = 'b1'
const TARGET = 'https://example.com/backed-up'
const HOUR_MS = 3_600_000
const SPOOL = '/var/lib/clickmonk/spool'
/** A sealed spool segment's name: the shipper's contract, from core. */
const SEGMENT = /^seg-\d{15}-\d+-\d+\.ndjson$/
const ARTEFACTS = ['caddy-data.tar', 'clickhouse.zip', 'env', 'postgres.dump', 'spool.tar']
/** Every service the stack suites run, the local authority and resolver included. */
const ALL_SERVICES = [
  'admin',
  'caddy',
  'clickhouse',
  'coredns',
  'pebble',
  'postgres',
  'redirect',
  'worker',
]

const BACKUPS = join(TMP, 'backups')
const ENV_FILE = join(TMP, 'backup.env')
/** The lock backup.sh and restore.sh share, in the checkout. */
const LOCK = join(ROOT, '.backup-restore.lock')
/** What restore.sh leaves while the stores may be half restored, in the checkout. */
const MARKER = join(ROOT, '.restore-incomplete')
const SCRIPT_ENV: Record<string, string | undefined> = {
  ...ENV,
  COMPOSE_FILE: 'docker-compose.yml:test/stack/docker-compose.tls.yml',
  COMPOSE_ENV_FILES: ENV_FILE,
}

let root = ''
let cookie = ''
let setUp = false
let failures = 0
/** The first backup the backup tests take. The refusal tests restore copies of it. */
let firstBackup = ''

interface ScriptResult {
  status: number
  out: string
}

function runScript(
  script: 'backup.sh' | 'restore.sh',
  args: string[],
  o: { input?: string; env?: Record<string, string> } = {},
): ScriptResult {
  const r = spawnSync(join(ROOT, script), args, {
    cwd: ROOT,
    env: { ...SCRIPT_ENV, ...o.env },
    input: o.input ?? '',
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 600_000,
  })
  if (r.error) throw new Error(`could not run ${script}: ${r.error.message}`)
  // A run ended by a signal has no status; a shell reports it as 128 + its number.
  const status = r.status ?? (r.signal ? 128 + constants.signals[r.signal] : -1)
  return { status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** The services running now, sorted. */
const running = (): string[] =>
  compose('ps', '--status', 'running', '--services')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()

/** When a service's container last started: a restart changes it, and nothing else does. */
function startedAt(service: string): string {
  const id = compose('ps', '-aq', service).trim()
  if (id === '') throw new Error(`no container for ${service}`)
  return execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', id], {
    encoding: 'utf8',
  }).trim()
}

const pg = (sql: string): string =>
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'clickmonk',
    '-d',
    'clickmonk',
    '-At',
    '-c',
    sql,
  ).trim()

/**
 * One ClickHouse statement, through the container's own credentials: the
 * password is read inside the container, so it is in no argument list here.
 */
const ch = (sql: string): string =>
  compose(
    'exec',
    '-T',
    'clickhouse',
    'sh',
    '-c',
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database clickmonk --query "$0"',
    sql,
  ).trim()

/** A number a store answered, never a silent zero from an empty answer. */
function num(out: string): number {
  const n = Number(out)
  if (out === '' || !Number.isInteger(n)) throw new Error(`the store answered "${out}"`)
  return n
}

/** The sealed segments in the spool now. */
const segments = (): string[] =>
  compose('exec', '-T', 'redirect', 'ls', '-1', SPOOL)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => SEGMENT.test(s))

/** Lines across every sealed segment: one line is one click. */
const spoolLines = (): number =>
  num(
    compose(
      'exec',
      '-T',
      'redirect',
      'sh',
      '-c',
      'cat "$0"/seg-*.ndjson 2>/dev/null | wc -l',
      SPOOL,
    ).trim(),
  )

/** A backup's MANIFEST as a map, split on the first `=` of each line as restore.sh splits it. */
function manifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(dir, 'MANIFEST'), 'utf8').split('\n')) {
    if (line === '') continue
    const eq = line.indexOf('=')
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/** The one directory a backup run wrote under `dest`. */
function onlyBackupIn(dest: string): string {
  const entries = readdirSync(dest)
  expect(entries, `${dest} should hold exactly one backup`).toHaveLength(1)
  return join(dest, entries[0] as string)
}

/** The schema version the stack's image understands, as the CLI prints it. */
function imageSchema(): number {
  const line = cli('version').trim()
  const m = /^clickmonk \d+\.\d+\.\d+ \(schema version (\d+)\)$/.exec(line)
  if (!m) throw new Error(`clickmonk version printed "${line}"`)
  return Number(m[1])
}

function api(
  method: string,
  path: string,
  o: { body?: string; cookie?: string; origin?: string; cacert?: string } = {},
): CurlResult {
  const args = ['--cacert', o.cacert ?? root, '--max-time', '60', '-X', method, '-D', '-']
  if (o.body !== undefined) {
    args.push('-H', 'content-type: application/json', '--data-binary', o.body)
  }
  if (o.cookie) args.push('-H', `cookie: ${o.cookie}`)
  if (o.origin !== undefined) args.push('-H', `origin: ${o.origin}`)
  args.push(`https://${ADMIN_HOST}${path}`)
  return curl(args, CA_MOUNT, { body: true })
}

const cookieFrom = (headers: string): string => {
  const line = headers.split('\n').find((l) => /^set-cookie:/i.test(l)) ?? ''
  return (line.slice(line.indexOf(':') + 1).split(';')[0] ?? '').trim()
}

function signIn(cacert?: string): CurlResult {
  return api('POST', '/api/session', {
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    origin: `https://${ADMIN_HOST}`,
    ...(cacert === undefined ? {} : { cacert }),
  })
}

/** A day either side of now, on the hour, so the summary counts every click this suite made. */
function window(): string {
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const from = new Date(hour - 24 * HOUR_MS).toISOString()
  const to = new Date(hour + 24 * HOUR_MS).toISOString()
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
}

/** Clicks the summary report counts; -1 while the admin service cannot answer. */
function reportedClicks(o: { cookie: string; cacert?: string }): number {
  const r = api('GET', `/api/reports/summary?${window()}`, o)
  if (r.status !== 200) return -1
  return (JSON.parse(r.body) as { clicks: number }).clicks
}

function click(): void {
  const r = curl(['-4', '--max-time', '30', `http://${LINK_HOST}/${SLUG}`])
  if (r.status !== 302) throw new Error(`the link answered ${r.status}`)
}

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures++
})

beforeAll(async () => {
  compose('down', '-v')
  rmSync(BACKUPS, { recursive: true, force: true })
  // A lock or marker a failed earlier run of this suite left would refuse every backup.
  rmSync(LOCK, { recursive: true, force: true })
  rmSync(MARKER, { force: true })
  rmSync(`${MARKER}.partial`, { recursive: true, force: true })
  mkdirSync(BACKUPS, { recursive: true })
  // The stack's own values, in the file the scripts copy as this install's
  // .env. Compose reads it too, through COMPOSE_ENV_FILES, and agrees with
  // the environment every other call here passes.
  writeFileSync(
    ENV_FILE,
    (
      [
        'POSTGRES_PASSWORD',
        'CLICKHOUSE_PASSWORD',
        'CLICKMONK_SECRET',
        'CLICKMONK_ADMIN_HOST',
      ] as const
    )
      .map((k) => `${k}=${ENV[k]}\n`)
      .join(''),
    { mode: 0o600 },
  )
  writeAcmeRoot()
  publishZone()
  compose('up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  root = writeIssuingRoot()
  cliWithInput(PASSWORD, 'admin', 'create', EMAIL)
  cli('domain', 'add', LINK_HOST, '--verified')
  cli('link', 'add', LINK_HOST, SLUG, '--target', TARGET)
  await until('a certificate for the admin host', 120_000, () => api('GET', '/api/me').exit === 0)
  const signedIn = signIn()
  if (signedIn.status !== 200)
    throw new Error(`sign-in failed: ${signedIn.status} ${signedIn.body}`)
  cookie = cookieFrom(signedIn.headers)
  // Two clicks shipped before any backup, so the counts a manifest records are
  // not all zero, where a count that was never taken would look the same.
  click()
  click()
  await until(
    'the first clicks to reach the reports',
    120_000,
    () => reportedClicks({ cookie }) === 2,
  )
  setUp = true
}, 900_000)

afterAll(() => {
  try {
    if (failures > 0 || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
    rmSync(BACKUPS, { recursive: true, force: true })
    rmSync(LOCK, { recursive: true, force: true })
    rmSync(MARKER, { force: true })
    rmSync(`${MARKER}.partial`, { recursive: true, force: true })
    rmSync(ENV_FILE, { force: true })
  }
}, 300_000)

/** A long step's budget: a script run, or a wait on the stack, inside one test. */
const LONG = 300_000

/** What the ClickHouse backups disk holds now; empty after every run. */
const backupsDisk = (): string =>
  compose(
    'exec',
    '-T',
    'clickhouse',
    'sh',
    '-c',
    'ls -A /var/lib/clickhouse/backups 2>/dev/null || true',
  ).trim()

/**
 * A `docker` first on PATH that answers the calls one `case` names and hands
 * every other call to the real one. `cases` is the body of a shell `case "$a"`
 * over each argument. Returns the PATH to run a script with.
 */
function stubDocker(cases: string): { path: string; remove: () => void } {
  const bin = join(TMP, 'stub-docker')
  rmSync(bin, { recursive: true, force: true })
  mkdirSync(bin)
  const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      cases,
      '  esac',
      'done',
      `exec ${real} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return {
    path: `${bin}:${process.env.PATH ?? ''}`,
    remove: () => rmSync(bin, { recursive: true, force: true }),
  }
}

describe('backup.sh', () => {
  it(
    'writes six files, readable by their owner alone, and a manifest that describes them',
    () => {
      const workerBefore = startedAt('worker')
      const redirectBefore = startedAt('redirect')
      const r = runScript('backup.sh', [join(BACKUPS, 'first')])
      expect(r.status, r.out).toBe(0)
      firstBackup = onlyBackupIn(join(BACKUPS, 'first'))

      expect(readdirSync(firstBackup).sort()).toEqual(['MANIFEST', ...ARTEFACTS])
      expect(statSync(firstBackup).mode & 0o777).toBe(0o700)
      for (const f of readdirSync(firstBackup)) {
        expect(statSync(join(firstBackup, f)).mode & 0o777, f).toBe(0o600)
      }

      const m = manifest(firstBackup)
      expect(Object.keys(m).sort()).toEqual(
        [
          'admin_host',
          'clickmonk_backup_version',
          'clickmonk_version',
          'rows.clickhouse.clicks',
          'rows.clickhouse.clicks_hourly',
          'rows.clickhouse.clicks_hourly_dim',
          'schema_version',
          'secret_fingerprint',
          ...ARTEFACTS.map((a) => `sha256.${a}`),
          'timestamp',
        ].sort(),
      )
      expect(m.clickmonk_backup_version).toBe('1')
      expect(m.timestamp).toBe(firstBackup.slice(firstBackup.lastIndexOf('/') + 1))
      expect(m.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z$/)
      expect(m.admin_host).toBe(ADMIN_HOST)
      expect(m.schema_version).toBe(pg('SELECT max(version) FROM schema_migrations'))
      // The release against the one the CLI prints; the schema version above is
      // the ledger's, which is the number a restore checks.
      const printed = /^clickmonk (\d+\.\d+\.\d+) \(schema version \d+\)$/.exec(
        cli('version').trim(),
      )
      expect(m.clickmonk_version).toBe(printed?.[1])
      for (const a of ARTEFACTS) expect(m[`sha256.${a}`], a).toBe(sha256(join(firstBackup, a)))
      // Counted by this test from the store, not read back from the manifest.
      expect(m['rows.clickhouse.clicks']).toBe(ch('SELECT count() FROM clicks FINAL'))
      expect(m['rows.clickhouse.clicks']).toBe('2')
      expect(m['rows.clickhouse.clicks_hourly']).toBe(ch('SELECT count() FROM clicks_hourly FINAL'))
      expect(m['rows.clickhouse.clicks_hourly_dim']).toBe(
        ch('SELECT count() FROM clicks_hourly_dim FINAL'),
      )
      // The secret itself is in `env`, which is the point of `env`; the manifest
      // carries only a fingerprint of it, computed here independently.
      expect(readFileSync(join(firstBackup, 'env'), 'utf8')).toBe(readFileSync(ENV_FILE, 'utf8'))
      const secret = ENV.CLICKMONK_SECRET ?? ''
      expect(m.secret_fingerprint).toBe(
        createHash('sha256').update(`clickmonk-secret:${secret}`).digest('hex').slice(0, 16),
      )
      expect(readFileSync(join(firstBackup, 'MANIFEST'), 'utf8')).not.toContain(secret)

      // The worker was stopped and started again; the redirect never stopped.
      expect(startedAt('worker')).not.toBe(workerBefore)
      expect(startedAt('redirect')).toBe(redirectBefore)
      expect(running()).toEqual(ALL_SERVICES)
    },
    LONG,
  )

  it('leaves nothing on the ClickHouse backups disk', () => {
    expect(backupsDisk()).toBe('')
  })

  // An archive a killed run's BACKUP finished after that run's trap had gone:
  // nothing else would ever remove it, and it is a whole backup's size.
  it(
    'removes an archive an earlier run left on the ClickHouse backups disk',
    () => {
      compose(
        'exec',
        '-T',
        'clickhouse',
        'touch',
        '/var/lib/clickhouse/backups/clickmonk-2000-01-01T000000Z-1.zip',
      )
      expect(backupsDisk()).toBe('clickmonk-2000-01-01T000000Z-1.zip')
      const r = runScript('backup.sh', [join(BACKUPS, 'orphan')])
      expect(r.status, r.out).toBe(0)
      onlyBackupIn(join(BACKUPS, 'orphan'))
      expect(backupsDisk()).toBe('')
    },
    LONG,
  )

  // Rows that share a sort key and have not been merged yet: the shipper's
  // normal case when a segment is shipped twice. A plain count() includes them,
  // and a restore that merged them would then disagree with the manifest.
  it(
    'records the counts ClickHouse gives with FINAL, not the unmerged rows',
    () => {
      const tables = ['clicks', 'clicks_hourly', 'clicks_hourly_dim']
      for (const t of tables) ch(`SYSTEM STOP MERGES ${t}`)
      try {
        ch('INSERT INTO clicks SELECT * FROM clicks LIMIT 1')
        expect(ch('SELECT count() FROM clicks')).toBe('3')
        expect(ch('SELECT count() FROM clicks FINAL')).toBe('2')
        const r = runScript('backup.sh', [join(BACKUPS, 'unmerged')])
        expect(r.status, r.out).toBe(0)
        const m = manifest(onlyBackupIn(join(BACKUPS, 'unmerged')))
        expect(m['rows.clickhouse.clicks']).toBe('2')
        for (const t of tables) {
          expect(m[`rows.clickhouse.${t}`], t).toBe(ch(`SELECT count() FROM ${t} FINAL`))
        }
      } finally {
        for (const t of tables) ch(`SYSTEM START MERGES ${t}`)
      }
    },
    LONG,
  )

  // An operator's wrapper reading destinations from a file: a docker call
  // that inherited the loop's stdin would swallow the rest of the list.
  it(
    'reads nothing from its standard input, so a while-read loop runs it for every line',
    () => {
      const a = join(BACKUPS, 'loop-a')
      const b = join(BACKUPS, 'loop-b')
      const r = spawnSync(
        'bash',
        ['-c', 'while read -r d; do "$0" "$d" || exit 1; done', join(ROOT, 'backup.sh')],
        {
          cwd: ROOT,
          env: SCRIPT_ENV,
          input: `${a}\n${b}\n`,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 600_000,
        },
      )
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      onlyBackupIn(a)
      onlyBackupIn(b)
    },
    LONG,
  )

  // A reader that goes away: `./backup.sh dest | head -1` in a cron line.
  it(
    'finishes the backup when whatever reads its output stops reading',
    () => {
      const dest = join(BACKUPS, 'head')
      const r = spawnSync(
        'bash',
        ['-c', '"$0" "$1" | head -1; exit ${PIPESTATUS[0]}', join(ROOT, 'backup.sh'), dest],
        {
          cwd: ROOT,
          env: SCRIPT_ENV,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 600_000,
        },
      )
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      expect(readdirSync(onlyBackupIn(dest))).toContain('MANIFEST')
      expect(running()).toEqual(ALL_SERVICES)
    },
    LONG,
  )

  it(
    'asks the worker for the release when the redirect is stopped',
    () => {
      compose('stop', 'redirect')
      try {
        const r = runScript('backup.sh', [join(BACKUPS, 'redirect-stopped')])
        expect(r.status, r.out).toBe(0)
        expect(r.out).not.toContain('predates')
        const m = manifest(onlyBackupIn(join(BACKUPS, 'redirect-stopped')))
        const printed = /^clickmonk (\d+\.\d+\.\d+) \(schema version \d+\)$/.exec(
          cli('version').trim(),
        )
        expect(printed).not.toBeNull()
        expect(m.clickmonk_version).toBe(printed?.[1])
      } finally {
        compose('start', 'redirect')
      }
    },
    LONG,
  )

  it(
    'leaves a worker it did not stop stopped, and still takes the backup',
    () => {
      // The redirect too, so that no container can say which release this is.
      compose('stop', 'worker', 'redirect')
      try {
        const r = runScript('backup.sh', [join(BACKUPS, 'worker-stopped')])
        expect(r.status, r.out).toBe(0)
        expect(r.out).toContain('The worker is not running; it is left that way.')
        expect(r.out).toContain('Neither the redirect nor the worker is running')
        expect(running()).not.toContain('worker')
        const m = manifest(onlyBackupIn(join(BACKUPS, 'worker-stopped')))
        expect(m.clickmonk_version).toBe('unknown')
      } finally {
        compose('start', 'redirect', 'worker')
      }
    },
    LONG,
  )

  // Caddy crash-looping on a bad Caddyfile is the likeliest broken service, and
  // the moment a backup is most wanted. Its volume is read through a one-off
  // container instead, and Caddy is left as it was.
  it(
    'takes the backup with Caddy stopped, and leaves it stopped',
    () => {
      compose('stop', 'caddy')
      try {
        const r = runScript('backup.sh', [join(BACKUPS, 'caddy-stopped')])
        expect(r.status, r.out).toBe(0)
        const dir = onlyBackupIn(join(BACKUPS, 'caddy-stopped'))
        // The certificate authority's account and the admin host's certificate
        // are in Caddy's data, so the archive lists more than its root entry.
        const listed = execFileSync('tar', ['-tf', join(dir, 'caddy-data.tar')], {
          encoding: 'utf8',
        })
        expect(listed).toMatch(/certificates\//)
        expect(running()).not.toContain('caddy')
      } finally {
        compose('start', 'caddy')
      }
    },
    LONG,
  )

  // Every install upgrading to the first release runs an image whose CLI has
  // no `version`: it prints its usage and exits 1. Its backup is the one the
  // upgrade instructions ask for first, so it must still be taken.
  it(
    'takes the backup from an image that predates `clickmonk version`, recording the release as unknown',
    () => {
      const stub = stubDocker('    version) echo "usage:"; exit 1 ;;')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [join(BACKUPS, 'old-image')], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain("The running image predates 'clickmonk version'")
      const m = manifest(onlyBackupIn(join(BACKUPS, 'old-image')))
      expect(m.clickmonk_version).toBe('unknown')
      expect(m.schema_version).toBe(pg('SELECT max(version) FROM schema_migrations'))
      expect(Object.keys(m)).toHaveLength(14)
    },
    LONG,
  )

  // The one step that runs while the worker is stopped is the one that fails
  // here, so "running again afterwards" is something the trap had to do.
  it(
    'starts the worker again, and leaves nothing behind, when a step fails while it is stopped',
    () => {
      // The lock is still held while the trap starts the worker: released
      // first, another run could start and find the worker stopped.
      const held = join(TMP, 'lock-held-at-start')
      rmSync(held, { force: true })
      const stub = stubDocker(
        [
          '    *"BACKUP DATABASE"*) echo "simulated failure of BACKUP" >&2; exit 1 ;;',
          `    start) [ -d ${LOCK} ] && touch ${held} ;;`,
        ].join('\n'),
      )
      const dest = join(BACKUPS, 'failed')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('the backup failed during the ClickHouse step')
      expect(r.out).toContain('No data was changed')
      expect(existsSync(held), 'the lock was gone when the worker was started').toBe(true)
      rmSync(held, { force: true })
      expect(existsSync(LOCK)).toBe(false)
      expect(readdirSync(dest)).toEqual([])
      expect(backupsDisk()).toBe('')
      expect(running()).toEqual(ALL_SERVICES)
      expect(startedAt('worker')).not.toBe(workerBefore)
    },
    LONG,
  )

  // An operator who sends TERM, sees the prompt wait while the trap starts the
  // worker, and sends it again. The stub sends both: the first during the
  // BACKUP, the second as the trap's `docker compose start` begins.
  it(
    'starts the worker again when a second TERM arrives while it is being started',
    () => {
      const stub = stubDocker(
        [
          '    *"BACKUP DATABASE"*) kill -TERM $PPID; sleep 1; exit 1 ;;',
          '    start) kill -TERM $PPID ;;',
        ].join('\n'),
      )
      const dest = join(BACKUPS, 'twice')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      try {
        expect(r.status, r.out).not.toBe(0)
        expect(running()).toEqual(ALL_SERVICES)
        expect(readdirSync(dest)).toEqual([])
        expect(backupsDisk()).toBe('')
        expect(existsSync(LOCK)).toBe(false)
      } finally {
        // A trap killed before its end leaves the lock; every later test
        // would then fail on it rather than on what it tests.
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // A dump that fails half way still wrote something, and without pipefail
  // the pipe's status is the write's: a truncated dump with a valid checksum.
  it(
    'fails, and keeps nothing, when pg_dump fails after writing part of the dump',
    () => {
      const stub = stubDocker('    *pg_dump*) printf PGDMP-partial; exit 1 ;;')
      const dest = join(BACKUPS, 'partial-dump')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('the backup failed during the Postgres step')
      expect(readdirSync(dest)).toEqual([])
      expect(running()).toEqual(ALL_SERVICES)
    },
    LONG,
  )

  // ClickHouse writes its archive beside its data. A backup that would not fit
  // is refused before the worker stops and before anything is written.
  it(
    'refuses a backup the ClickHouse volume has no room for, before stopping anything',
    () => {
      const stub = stubDocker('    *"free_space FROM system.disks"*) echo 1; exit 0 ;;')
      const dest = join(BACKUPS, 'no-room')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('The ClickHouse volume has 0 MiB free and a backup needs about')
      expect(r.out).toContain('the backup failed during the validation step')
      expect(readdirSync(BACKUPS)).not.toContain('no-room')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // A size ClickHouse cannot give must not count as zero bytes needed.
  it(
    'refuses when ClickHouse cannot say how much its database holds, before stopping anything',
    () => {
      const stub = stubDocker('    *"FROM system.parts"*) exit 1 ;;')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [join(BACKUPS, 'no-size')], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain("Could not read ClickHouse's size and free space: 'nothing'")
      expect(r.out).toContain('the backup failed during the validation step')
      expect(readdirSync(BACKUPS)).not.toContain('no-size')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // Every install from before the backups disk existed, until ClickHouse is
  // recreated: system.disks has no such row, and nothing else would say why.
  it(
    'refuses a ClickHouse started without the backups disk, before stopping anything',
    () => {
      const stub = stubDocker('    *"FROM system.disks"*) exit 0 ;;')
      const dest = join(BACKUPS, 'no-disk')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain("ClickHouse has no disk named 'backups'")
      expect(r.out).toContain('the backup failed during the validation step')
      expect(readdirSync(BACKUPS)).not.toContain('no-disk')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // Two runs started in the same second name the same directory. The second
  // must fail without touching it, since the first is still writing there.
  it(
    'refuses a backup directory that already exists, and leaves it as it was',
    () => {
      const bin = join(TMP, 'stub-date')
      rmSync(bin, { recursive: true, force: true })
      mkdirSync(bin)
      writeFileSync(join(bin, 'date'), '#!/bin/sh\necho 2026-10-01T041500Z\n', { mode: 0o755 })
      const theirs = join(BACKUPS, 'same-second', '2026-10-01T041500Z')
      mkdirSync(theirs, { recursive: true })
      writeFileSync(join(theirs, 'marker'), 'written by the other run\n')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [join(BACKUPS, 'same-second')], {
          env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        })
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('Another backup started in the same second')
      expect(r.out).toContain('the backup failed during the destination step')
      expect(readdirSync(theirs)).toEqual(['marker'])
      expect(readFileSync(join(theirs, 'marker'), 'utf8')).toBe('written by the other run\n')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  it(
    'refuses a destination it cannot create, before stopping anything',
    () => {
      const workerBefore = startedAt('worker')
      // A path under a regular file: no mkdir can make it.
      const r = runScript('backup.sh', [join(ENV_FILE, 'nested')])
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('the backup failed during the destination step')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  it(
    'refuses when COMPOSE_ENV_FILES names more than one file, before stopping anything',
    () => {
      const workerBefore = startedAt('worker')
      const r = runScript('backup.sh', [join(BACKUPS, 'two-env-files')], {
        env: { COMPOSE_ENV_FILES: `${ENV_FILE},${ENV_FILE}` },
      })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('COMPOSE_ENV_FILES names more than one file')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // A worker that will not start again: the backup is kept and the run fails
  // saying so, and the lock is released, or every later run would refuse.
  it(
    'releases the lock when it cannot start the worker again',
    () => {
      const stub = stubDocker('    start) exit 1 ;;')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [join(BACKUPS, 'no-restart')], { env: { PATH: stub.path } })
      } finally {
        stub.remove()
        compose('start', 'worker')
      }
      try {
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('the worker is stopped and this script could not start it again')
        onlyBackupIn(join(BACKUPS, 'no-restart'))
        expect(existsSync(LOCK)).toBe(false)
      } finally {
        // A lock left here would fail every later test on the lock instead.
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // A BACKUP or RESTORE whose client was killed runs on in the server. Its
  // archive is what the sweep would delete, so the backup waits for it.
  it(
    'refuses while ClickHouse is still running an earlier backup or restore, before stopping anything',
    () => {
      const stub = stubDocker(
        `    *"FROM system.backups"*) echo "RESTORING Disk('backups', 'clickmonk-restore-2026-10-01T041500Z.zip')"; exit 0 ;;`,
      )
      const dest = join(BACKUPS, 'in-progress')
      const workerBefore = startedAt('worker')
      compose(
        'exec',
        '-T',
        'clickhouse',
        'touch',
        '/var/lib/clickhouse/backups/clickmonk-restore-2026-10-01T041500Z.zip',
      )
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [dest], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(
          "ClickHouse is still running an earlier backup or restore: RESTORING Disk('backups', 'clickmonk-restore-2026-10-01T041500Z.zip').",
        )
        expect(r.out).toContain('Wait for it to finish')
        expect(r.out).toContain('the backup failed during the validation step')
        // Its archive is left for it.
        expect(backupsDisk()).toBe('clickmonk-restore-2026-10-01T041500Z.zip')
        expect(readdirSync(BACKUPS)).not.toContain('in-progress')
        expect(startedAt('worker')).toBe(workerBefore)
      } finally {
        stub.remove()
        compose(
          'exec',
          '-T',
          'clickhouse',
          'rm',
          '-f',
          '/var/lib/clickhouse/backups/clickmonk-restore-2026-10-01T041500Z.zip',
        )
      }
    },
    LONG,
  )

  // Not knowing is not the same as nothing running: the sweep waits for an answer.
  it(
    'refuses when ClickHouse cannot say whether a backup or restore is running',
    () => {
      const stub = stubDocker('    *"FROM system.backups"*) exit 1 ;;')
      const workerBefore = startedAt('worker')
      let r: ScriptResult
      try {
        r = runScript('backup.sh', [join(BACKUPS, 'unknown-progress')], {
          env: { PATH: stub.path },
        })
      } finally {
        stub.remove()
      }
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain(
        'Could not ask ClickHouse whether a backup or restore is still running.',
      )
      expect(readdirSync(BACKUPS)).not.toContain('unknown-progress')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // Compose itself fails on an env file it cannot find, so a check of the
  // services first would blame a store that is running.
  it(
    'names a missing env file, rather than a store, before stopping anything',
    () => {
      const missing = join(TMP, 'no-such.env')
      const workerBefore = startedAt('worker')
      const r = runScript('backup.sh', [join(BACKUPS, 'no-env')], {
        env: { COMPOSE_ENV_FILES: missing },
      })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain(`Cannot read ${missing}`)
      expect(r.out).not.toContain('service is not running')
      expect(startedAt('worker')).toBe(workerBefore)
    },
    LONG,
  )

  // Two runs at once: the second would take the worker the first stopped for
  // one it may leave alone, and copy while the first starts it again.
  it(
    'refuses while another run holds the lock, and leaves that run to finish',
    async () => {
      const reached = join(TMP, 'lock-reached')
      const release = join(TMP, 'lock-release')
      rmSync(reached, { force: true })
      rmSync(release, { force: true })
      // The holder's BACKUP runs for real and it pauses after it, with its
      // archive on the backups disk: a refused run must not sweep it away.
      const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
      const stub = stubDocker(
        `    *"BACKUP DATABASE"*) ${real} "$@"; rc=$?; touch ${reached}; while [ ! -e ${release} ]; do sleep 0.2; done; exit $rc ;;`,
      )
      const first = join(BACKUPS, 'holder')
      let out = ''
      const holder = spawn(join(ROOT, 'backup.sh'), [first], {
        cwd: ROOT,
        env: { ...SCRIPT_ENV, PATH: stub.path },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      holder.stdout.on('data', (d: Buffer) => {
        out += d.toString()
      })
      holder.stderr.on('data', (d: Buffer) => {
        out += d.toString()
      })
      const done = new Promise<number>((resolve) =>
        holder.on('close', (code) => resolve(code ?? -1)),
      )
      try {
        await until('the first run to reach its BACKUP', 120_000, () => existsSync(reached))
        const holderPid = readFileSync(join(LOCK, 'pid'), 'utf8').trim()
        expect(holderPid).toBe(String(holder.pid))

        const r = runScript('backup.sh', [join(BACKUPS, 'second')])
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(`Another backup or restore holds ${LOCK} (pid ${holderPid})`)
        expect(r.out).toContain('the backup failed during the validation step')
        expect(readdirSync(BACKUPS)).not.toContain('second')
        // The first run's lock, and its stopped worker, are as it left them.
        expect(readFileSync(join(LOCK, 'pid'), 'utf8').trim()).toBe(holderPid)
        expect(running()).not.toContain('worker')
        expect(backupsDisk()).toMatch(/^clickmonk-.*\.zip$/m)
      } finally {
        // Let the holder finish even when an assertion above failed, so the
        // next test does not start beside it.
        writeFileSync(release, '')
        await done
        stub.remove()
        rmSync(reached, { force: true })
        rmSync(release, { force: true })
      }
      const status = await done
      expect(status, out).toBe(0)
      onlyBackupIn(first)
      expect(existsSync(LOCK)).toBe(false)
      expect(running()).toEqual(ALL_SERVICES)
    },
    LONG,
  )

  // A run killed with SIGKILL leaves its lock. It is never taken over: two
  // runs that both judged it stale would both hold it.
  it(
    'refuses a lock left by a run that was killed, and says how to remove it',
    () => {
      mkdirSync(LOCK)
      writeFileSync(join(LOCK, 'pid'), '4242\n')
      const workerBefore = startedAt('worker')
      try {
        const r = runScript('backup.sh', [join(BACKUPS, 'stale-lock')])
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(`Another backup or restore holds ${LOCK} (pid 4242)`)
        expect(r.out).toContain(`rm -rf ${LOCK}`)
        expect(readFileSync(join(LOCK, 'pid'), 'utf8')).toBe('4242\n')
        expect(readdirSync(BACKUPS)).not.toContain('stale-lock')
        expect(startedAt('worker')).toBe(workerBefore)
      } finally {
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // A restore interrupted part way leaves stores from two moments; a backup
  // of them would be complete, checksummed and of a state that never existed.
  it(
    'refuses while a restore has not finished, and names the backup to finish it with',
    () => {
      writeFileSync(MARKER, '/srv/backups/2026-10-01T041500Z\n')
      const workerBefore = startedAt('worker')
      try {
        const r = runScript('backup.sh', [join(BACKUPS, 'half-restored')])
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(
          'A restore of /srv/backups/2026-10-01T041500Z did not finish, so the stores may be half restored.',
        )
        expect(r.out).toContain('restore.sh /srv/backups/2026-10-01T041500Z')
        expect(r.out).toContain('the backup failed during the validation step')
        expect(readdirSync(BACKUPS)).not.toContain('half-restored')
        expect(startedAt('worker')).toBe(workerBefore)
        expect(existsSync(MARKER)).toBe(true)
      } finally {
        rmSync(MARKER, { force: true })
      }
    },
    LONG,
  )

  // The worker stopped, clicks written, and the worker started again: a spool
  // copied after the start would find their segments shipped and deleted, and
  // a ClickHouse backup taken before it would not have them either. The stub
  // holds the stop open until the clicks are sealed, and holds the start until
  // the worker has drained the spool, so that ordering is seen every time.
  it(
    'every click written before the worker stopped is in the backup: in ClickHouse or in spool.tar',
    async () => {
      const stopped = join(TMP, 'worker-stopped')
      const go = join(TMP, 'worker-may-start')
      rmSync(stopped, { force: true })
      rmSync(go, { force: true })
      const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
      const stub = stubDocker(
        [
          '    stop)',
          `      case " $* " in *" worker "*) ${real} "$@" || exit 1; touch ${stopped}`,
          `        i=0; while [ ! -e ${go} ] && [ $i -lt 240 ]; do sleep 0.5; i=$((i + 1)); done; exit 0 ;; esac ;;`,
          '    start)',
          `      case " $* " in *" worker "*) ${real} "$@" || exit 1`,
          '        i=0; while [ $i -lt 240 ]; do',
          `          n=$(${real} compose exec -T redirect sh -c 'ls "$0" | grep -c "^seg-"' ${SPOOL} </dev/null)`,
          `          [ "$n" = 0 ] && exit 0; sleep 0.5; i=$((i + 1)); done; exit 0 ;; esac ;;`,
        ].join('\n'),
      )
      const dest = join(BACKUPS, 'ordering')
      try {
        const child = spawn(join(ROOT, 'backup.sh'), [dest], {
          cwd: ROOT,
          env: { ...SCRIPT_ENV, PATH: stub.path },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString()
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString()
        })
        const exited = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)))
        await until('the backup to stop the worker', 60_000, () => existsSync(stopped))
        // With the worker stopped, nothing moves between the two.
        const inStore = num(ch('SELECT count() FROM clicks FINAL'))
        const waiting = spoolLines()
        const before = inStore + waiting
        click()
        click()
        await until('the two clicks sealed', 60_000, () => spoolLines() === waiting + 2)
        writeFileSync(go, '')
        const status = await exited
        expect(status, out).toBe(0)
        const dir = onlyBackupIn(dest)
        const inSpool = execFileSync('tar', ['-xOf', join(dir, 'spool.tar')], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l !== '').length
        expect(inSpool).toBeGreaterThanOrEqual(2)
        expect(num(manifest(dir)['rows.clickhouse.clicks'] ?? '') + inSpool).toBe(before + 2)
      } finally {
        stub.remove()
        rmSync(stopped, { force: true })
        rmSync(go, { force: true })
      }
    },
    LONG,
  )

  it(
    'parses, and prints its usage, under bash 3.2',
    () => {
      for (const script of ['backup.sh', 'backup-lib.sh', 'restore.sh']) {
        const parsed = spawnSync(
          'docker',
          ['run', '--rm', '-v', `${ROOT}:/src:ro`, 'bash:3.2.57', 'bash', '-n', `/src/${script}`],
          { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 },
        )
        expect(parsed.status, `${script}: ${parsed.stderr}`).toBe(0)
      }
      for (const script of ['backup.sh', 'restore.sh']) {
        const help = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${ROOT}:/src:ro`,
            'bash:3.2.57',
            'bash',
            `/src/${script}`,
            '--help',
          ],
          { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 },
        )
        expect(help.status, `${script}: ${help.stderr}`).toBe(0)
        expect(help.stderr).toContain(`usage: ./${script}`)
      }
    },
    LONG,
  )
})

describe('restore.sh refuses, before it stops or changes anything', () => {
  interface World {
    running: string[]
    redirectStarted: string
    links: string
    clicks: string
    /** A refused run releases the lock it took, and leaves one it did not take. */
    locked: boolean
  }
  /** What a refusal must leave exactly as it found it. */
  const world = (): World => ({
    running: running(),
    redirectStarted: startedAt('redirect'),
    links: pg('SELECT count(*) FROM links'),
    clicks: ch('SELECT count() FROM clicks FINAL'),
    locked: existsSync(LOCK),
  })

  /** A copy of the first backup, to damage without damaging the original. */
  function copyOfFirst(name: string): string {
    const dir = join(BACKUPS, 'copies', name)
    rmSync(dir, { recursive: true, force: true })
    cpSync(firstBackup, dir, { recursive: true })
    return dir
  }

  function expectRefusal(r: ScriptResult, reason: string, before: World): void {
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(reason)
    expect(r.out).toContain('Nothing was changed, and nothing was stopped.')
    expect(r.out).not.toContain('Stopped before anything was changed.')
    expect(world()).toEqual(before)
  }

  it(
    'refuses a directory that is not one backup',
    () => {
      const before = world()
      // The destination backup.sh was given, rather than the directory it wrote.
      expectRefusal(
        runScript('restore.sh', [join(BACKUPS, 'first')], { input: 'irrelevant\n' }),
        'There is no MANIFEST in',
        before,
      )
    },
    LONG,
  )

  it(
    'refuses a backup missing one of its files',
    () => {
      const dir = copyOfFirst('missing')
      rmSync(join(dir, 'env'))
      const before = world()
      expectRefusal(runScript('restore.sh', [dir]), 'env is missing or empty', before)
    },
    LONG,
  )

  it(
    'refuses a damaged file, by its checksum',
    () => {
      const dir = copyOfFirst('damaged')
      appendFileSync(join(dir, 'postgres.dump'), 'x')
      const before = world()
      expectRefusal(
        runScript('restore.sh', [dir]),
        'postgres.dump does not match the checksum in the manifest',
        before,
      )
    },
    LONG,
  )

  it(
    'refuses a backup newer than the image that would run it',
    () => {
      const dir = copyOfFirst('newer')
      const path = join(dir, 'MANIFEST')
      const newer = imageSchema() + 1
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(/^schema_version=\d+$/m, `schema_version=${newer}`),
      )
      const before = world()
      expectRefusal(runScript('restore.sh', [dir]), 'This backup is newer than this image', before)
    },
    LONG,
  )

  it(
    'refuses when the answer is not the backup’s timestamp',
    () => {
      const before = world()
      const r = runScript('restore.sh', [firstBackup], { input: 'yes\n' })
      expect(r.out).toContain('Type the backup’s timestamp to go ahead')
      // The same secret and admin host as the backup's, so neither warning.
      expect(r.out).not.toContain('is not the one this backup was taken with')
      expect(r.out).not.toContain('CLICKMONK_ADMIN_HOST is')
      expectRefusal(r, 'That is not the backup’s timestamp', before)
    },
    LONG,
  )

  it(
    'refuses when nobody answers',
    () => {
      const before = world()
      expectRefusal(
        runScript('restore.sh', [firstBackup], { input: '' }),
        'That is not the backup’s timestamp',
        before,
      )
    },
    LONG,
  )

  it(
    'warns, before asking, when this install signs cookies with a different secret',
    () => {
      const other = join(TMP, 'backup-other-secret.env')
      writeFileSync(
        other,
        readFileSync(ENV_FILE, 'utf8').replace(
          /^CLICKMONK_SECRET=.*$/m,
          `CLICKMONK_SECRET=${'o'.repeat(40)}`,
        ),
        { mode: 0o600 },
      )
      const before = world()
      try {
        const r = runScript('restore.sh', [firstBackup], {
          input: 'no\n',
          env: { COMPOSE_ENV_FILES: other },
        })
        expect(r.out).toContain('is not the one this backup was taken with')
        expect(r.out.indexOf('is not the one this backup was taken with')).toBeLessThan(
          r.out.indexOf('Type the backup’s timestamp to go ahead'),
        )
        expectRefusal(r, 'That is not the backup’s timestamp', before)
      } finally {
        rmSync(other, { force: true })
      }
    },
    LONG,
  )

  it(
    'refuses a path that is not a directory',
    () => {
      const before = world()
      const missing = join(BACKUPS, 'no-such-backup')
      expectRefusal(runScript('restore.sh', [missing]), `${missing} is not a directory`, before)
    },
    LONG,
  )

  // One manifest line changed or taken away at a time. Each is refused by its
  // own guard, before anything is asked of the stack.
  it.each([
    {
      what: 'a format this script does not read',
      edit: (m: string) =>
        m.replace(/^clickmonk_backup_version=.*$/m, 'clickmonk_backup_version=2'),
      reason: "Its format is '2'; this script reads 1.",
    },
    {
      what: 'no timestamp',
      edit: (m: string) => m.replace(/^timestamp=.*\n/m, ''),
      reason: 'The manifest has no timestamp.',
    },
    {
      // The timestamp is part of a file name and of a ClickHouse statement.
      what: 'a timestamp backup.sh would not write',
      edit: (m: string) => m.replace(/^timestamp=.*$/m, "timestamp=2026-10-01T041500Z')"),
      reason:
        "The manifest's timestamp is '2026-10-01T041500Z')', which is not one backup.sh writes.",
    },
    {
      what: 'a schema version that is not a number',
      edit: (m: string) => m.replace(/^schema_version=.*$/m, 'schema_version=ten'),
      reason: "The manifest's schema_version is 'ten', which is not a number.",
    },
    {
      what: 'no row count for one table',
      edit: (m: string) => m.replace(/^rows\.clickhouse\.clicks_hourly_dim=.*\n/m, ''),
      reason: 'The manifest records no row count for clicks_hourly_dim',
    },
    {
      what: 'no checksum for one file',
      edit: (m: string) => m.replace(/^sha256\.env=.*\n/m, ''),
      reason: 'The manifest records no checksum for env.',
    },
  ])(
    'refuses a manifest with $what',
    ({ what, edit, reason }) => {
      const dir = copyOfFirst(`manifest-${what.replaceAll(' ', '-')}`)
      const path = join(dir, 'MANIFEST')
      const edited = edit(readFileSync(path, 'utf8'))
      expect(edited).not.toBe(readFileSync(path, 'utf8'))
      writeFileSync(path, edited)
      const before = world()
      expectRefusal(runScript('restore.sh', [dir]), reason, before)
    },
    LONG,
  )

  // A file it cannot check is not restored. Every tool on PATH but those three.
  it(
    'refuses on a host with no SHA-256 tool',
    () => {
      const bin = join(TMP, 'no-sha256')
      rmSync(bin, { recursive: true, force: true })
      mkdirSync(bin)
      const linked = new Set(['sha256sum', 'shasum', 'openssl'])
      for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir === '' || !existsSync(dir) || !statSync(dir).isDirectory()) continue
        for (const name of readdirSync(dir)) {
          if (linked.has(name)) continue
          linked.add(name)
          symlinkSync(join(dir, name), join(bin, name))
        }
      }
      const before = world()
      try {
        expectRefusal(
          runScript('restore.sh', [firstBackup], { env: { PATH: bin } }),
          'No SHA-256 tool found',
          before,
        )
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // Compose itself fails on an env file it cannot find, so a check of the
  // services first would blame a store that is running.
  it(
    'names a missing env file, rather than a store',
    () => {
      const missing = join(TMP, 'no-such.env')
      const before = world()
      const r = runScript('restore.sh', [firstBackup], { env: { COMPOSE_ENV_FILES: missing } })
      expect(r.out).not.toContain('service is not running')
      expectRefusal(r, `Cannot read ${missing}`, before)
    },
    LONG,
  )

  it(
    'refuses when COMPOSE_ENV_FILES names more than one file',
    () => {
      const before = world()
      expectRefusal(
        runScript('restore.sh', [firstBackup], {
          env: { COMPOSE_ENV_FILES: `${ENV_FILE},${ENV_FILE}` },
        }),
        'COMPOSE_ENV_FILES names more than one file',
        before,
      )
    },
    LONG,
  )

  it(
    'refuses when a store is not running',
    () => {
      // Compose answers that only Postgres is running; the stack itself is untouched.
      const stub = stubDocker('    --services) echo postgres; exit 0 ;;')
      const before = world()
      try {
        expectRefusal(
          runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } }),
          "The 'clickhouse' service is not running.",
          before,
        )
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  // A second run while a backup or restore holds the lock: a backup's sweep
  // would delete the archive a restore is reading.
  it(
    'refuses while another run holds the lock, and leaves the lock alone',
    () => {
      mkdirSync(LOCK)
      writeFileSync(join(LOCK, 'pid'), '4242\n')
      const before = world()
      try {
        const r = runScript('restore.sh', [firstBackup])
        expect(r.out).toContain(`rm -rf ${LOCK}`)
        expectRefusal(r, `Another backup or restore holds ${LOCK} (pid 4242)`, before)
        expect(readFileSync(join(LOCK, 'pid'), 'utf8')).toBe('4242\n')
      } finally {
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // A restore killed part way whose RESTORE the server is still running: a
  // second one would drop the database under it.
  it(
    'refuses while ClickHouse is still running an earlier backup or restore',
    () => {
      const stub = stubDocker(
        `    *"FROM system.backups"*) echo "RESTORING Disk('backups', 'clickmonk-restore-2026-10-01T041500Z-1.zip')"; exit 0 ;;`,
      )
      const before = world()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.out).toContain('Wait for it to finish')
        expectRefusal(
          r,
          "ClickHouse is still running an earlier backup or restore: RESTORING Disk('backups', 'clickmonk-restore-2026-10-01T041500Z-1.zip').",
          before,
        )
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  it(
    'refuses when ClickHouse cannot say whether a backup or restore is running',
    () => {
      const stub = stubDocker('    *"FROM system.backups"*) exit 1 ;;')
      const before = world()
      try {
        expectRefusal(
          runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } }),
          'Could not ask ClickHouse whether a backup or restore is still running.',
          before,
        )
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  // Without the disk the RESTORE fails, and it runs after the DROP: the one
  // failure that would leave ClickHouse empty is refused before it.
  it(
    'refuses a ClickHouse started without the backups disk',
    () => {
      const stub = stubDocker('    *"FROM system.disks"*) exit 0 ;;')
      const before = world()
      try {
        expectRefusal(
          runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } }),
          "ClickHouse has no disk named 'backups'",
          before,
        )
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  it(
    'refuses when the image cannot say which schema version it understands',
    () => {
      const stub = stubDocker('    version) echo "usage:"; exit 1 ;;')
      const before = world()
      try {
        expectRefusal(
          runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } }),
          "Could not read the schema version this checkout's image understands.",
          before,
        )
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  // Half way through an upgrade the running containers are older than the
  // image `up` starts. Here a running container claims schema version 1, below
  // the backup's: asked instead of the image, it would refuse the backup as newer.
  it(
    'reads the schema version from the image `up` would start, not a running container',
    () => {
      const stub = stubDocker(
        '    version) case " $* " in *" exec "*) echo "clickmonk 0.0.0 (schema version 1)"; exit 0 ;; esac ;;',
      )
      const before = world()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.out).not.toContain('This backup is newer than this image')
        expect(r.out).toContain(`This image understands schema version ${imageSchema()}`)
        expectRefusal(r, 'That is not the backup’s timestamp', before)
      } finally {
        stub.remove()
      }
    },
    LONG,
  )

  it(
    'warns, before asking, when the admin host differs from the backup’s',
    () => {
      const other = join(TMP, 'backup-other-host.env')
      writeFileSync(
        other,
        readFileSync(ENV_FILE, 'utf8').replace(
          /^CLICKMONK_ADMIN_HOST=.*$/m,
          'CLICKMONK_ADMIN_HOST=elsewhere.example.test',
        ),
        { mode: 0o600 },
      )
      const before = world()
      try {
        const r = runScript('restore.sh', [firstBackup], {
          input: 'no\n',
          env: { COMPOSE_ENV_FILES: other },
        })
        const warning = `CLICKMONK_ADMIN_HOST is 'elsewhere.example.test' here and was '${ADMIN_HOST}'`
        expect(r.out).toContain(warning)
        expect(r.out).not.toContain('is not the one this backup was taken with')
        expect(r.out.indexOf(warning)).toBeLessThan(
          r.out.indexOf('Type the backup’s timestamp to go ahead'),
        )
        expectRefusal(r, 'That is not the backup’s timestamp', before)
      } finally {
        rmSync(other, { force: true })
      }
    },
    LONG,
  )
})

describe('restore.sh refuses, after an interrupted restore or on a full disk', () => {
  const unchanged = (): { running: string[]; redirect: string; locked: boolean } => ({
    running: running(),
    redirect: startedAt('redirect'),
    locked: existsSync(LOCK),
  })

  // Between a DROP and its RESTORE the clickmonk database does not exist, and
  // naming it is itself an error. A rerun must still get as far as asking.
  it(
    'asks nothing of the clickmonk database before the prompt',
    () => {
      const stub = stubDocker(
        '    clickmonk) echo "Database clickmonk does not exist" >&2; exit 1 ;;',
      )
      const b = unchanged()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('That is not the backup’s timestamp')
        expect(r.out).toContain('Nothing was changed, and nothing was stopped.')
      } finally {
        stub.remove()
      }
      expect(unchanged()).toEqual(b)
    },
    LONG,
  )

  // The RESTORE runs after the DROP; a disk that fills there leaves ClickHouse
  // partial with the stack stopped.
  it(
    'refuses a restore the ClickHouse volume has no room for',
    () => {
      const stub = stubDocker(
        [
          '    *"free_space FROM system.disks"*) echo 1; exit 0 ;;',
          '    *"FROM system.parts"*) echo 0; exit 0 ;;',
        ].join('\n'),
      )
      const b = unchanged()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(
          'The ClickHouse volume has 0 MiB free, and 0 MiB more once its database is dropped',
        )
        expect(r.out).toContain('Nothing was changed, and nothing was stopped.')
        expect(r.out).not.toContain('Type the backup’s timestamp')
      } finally {
        stub.remove()
      }
      expect(unchanged()).toEqual(b)
    },
    LONG,
  )

  // The restore needs the archive and the restored database side by side:
  // two and a half times the archive, less what the DROP frees. Twice is short.
  it(
    'refuses a volume with room for exactly twice the archive',
    () => {
      const twice = 2 * statSync(join(firstBackup, 'clickhouse.zip')).size
      const stub = stubDocker(
        [
          `    *"free_space FROM system.disks"*) echo ${twice}; exit 0 ;;`,
          '    *"FROM system.parts"*) echo 0; exit 0 ;;',
        ].join('\n'),
      )
      const b = unchanged()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('this restore needs about')
        expect(r.out).toContain('Nothing was changed, and nothing was stopped.')
      } finally {
        stub.remove()
      }
      expect(unchanged()).toEqual(b)
    },
    LONG,
  )

  // One size ClickHouse cannot give: it must not count as zero bytes to free.
  it(
    'refuses when ClickHouse cannot say how much its database holds',
    () => {
      const stub = stubDocker('    *"FROM system.parts"*) exit 1 ;;')
      const b = unchanged()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(
          "Could not read the archive's size and ClickHouse's size and free space",
        )
        expect(r.out).toContain('Nothing was changed, and nothing was stopped.')
      } finally {
        stub.remove()
      }
      expect(unchanged()).toEqual(b)
    },
    LONG,
  )

  // Ctrl-C during the checks: without a word the prompt would be the last thing said.
  it(
    'says it stopped before anything was changed when a signal arrives during the checks',
    () => {
      const stub = stubDocker(`    --services) kill -TERM "$(cat ${LOCK}/pid)"; sleep 1; exit 1 ;;`)
      const b = unchanged()
      try {
        const r = runScript('restore.sh', [firstBackup], { env: { PATH: stub.path } })
        expect(r.status, r.out).toBe(143)
        expect(r.out).toContain('Stopped before anything was changed.')
        expect(r.out).not.toContain('stopped part way')
      } finally {
        stub.remove()
      }
      expect(unchanged()).toEqual(b)
    },
    LONG,
  )
})

describe('restore.sh, stopped before it changes anything', () => {
  // An operator who sends TERM while the archive is copied in, and again while
  // the services are being started: the second must not abandon the trap.
  it(
    'starts again what it stopped, and leaves nothing behind, when a second TERM arrives while it does',
    () => {
      const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
      const stub = stubDocker(
        [
          `    *"cat >"*) ${real} "$@"; kill -TERM $PPID; sleep 1; exit 1 ;;`,
          '    start) kill -TERM $PPID ;;',
        ].join('\n'),
      )
      const runningBefore = running()
      const links = pg('SELECT count(*) FROM links')
      const clicks = ch('SELECT count() FROM clicks FINAL')
      const redirectBefore = startedAt('redirect')
      let r: ScriptResult
      try {
        r = runScript('restore.sh', [firstBackup], {
          input: `${manifest(firstBackup).timestamp}\n`,
          env: { PATH: stub.path },
        })
      } finally {
        stub.remove()
      }
      try {
        expect(r.status, r.out).not.toBe(0)
        expect(r.out).toContain(
          'Nothing was changed. Starting caddy redirect admin worker again...',
        )
        expect(r.out).not.toContain('stopped part way')
        // Stopped and started again: nothing else about the install moved.
        expect(startedAt('redirect')).not.toBe(redirectBefore)
        expect(running()).toEqual(runningBefore)
        expect(pg('SELECT count(*) FROM links')).toBe(links)
        expect(ch('SELECT count() FROM clicks FINAL')).toBe(clicks)
        expect(backupsDisk()).toBe('')
        expect(existsSync(LOCK)).toBe(false)
      } finally {
        // A trap killed before its end leaves the lock.
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )
})

// These change the stores and restore them again, so they come last.
describe('restore.sh, interrupted after it has changed a store', () => {
  const APPS = ['admin', 'caddy', 'redirect', 'worker']
  const stamp = (): string => manifest(firstBackup).timestamp ?? ''

  /** TERM to restore.sh, from inside the docker call the `cases` name, once that call has run. */
  function interruptAt(pattern: string): { path: string; remove: () => void } {
    const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
    return stubDocker(
      `    ${pattern}) ${real} "$@"; kill -TERM "$(cat ${LOCK}/pid)"; sleep 2; exit 1 ;;`,
    )
  }

  function expectLeftStopped(r: ScriptResult, state: string): void {
    expect(r.status, r.out).toBe(143)
    expect(r.out).toContain(`The restore stopped part way: ${state}`)
    expect(r.out).not.toContain('Nothing was changed')
    expect(r.out).not.toContain('Stopped before anything was changed')
    const up = running()
    for (const s of APPS) expect(up, s).not.toContain(s)
    expect(readFileSync(MARKER, 'utf8')).toBe(`${firstBackup}\n`)
    expect(existsSync(LOCK)).toBe(false)
    expect(backupsDisk()).toBe('')
  }

  function expectFinishedByRerun(): void {
    const r = runScript('restore.sh', [firstBackup], { input: `${stamp()}\n` })
    expect(r.status, r.out).toBe(0)
    expect(existsSync(MARKER)).toBe(false)
    expect(existsSync(LOCK)).toBe(false)
    expect(running()).toEqual(ALL_SERVICES)
    expect(ch('SELECT count() FROM clicks FINAL')).toBe(
      manifest(firstBackup)['rows.clickhouse.clicks'],
    )
  }

  it(
    'leaves the stack stopped at the spool step, refuses a backup, and finishes when run again',
    () => {
      const stub = interruptAt('/var/lib/clickmonk/spool')
      let r: ScriptResult
      try {
        r = runScript('restore.sh', [firstBackup], {
          input: `${stamp()}\n`,
          env: { PATH: stub.path },
        })
      } finally {
        stub.remove()
      }
      try {
        expectLeftStopped(r, 'ClickHouse and Postgres are restored; the spool was being replaced')
        expect(r.out).not.toContain('may still be finishing')

        const b = runScript('backup.sh', [join(BACKUPS, 'half-restored-for-real')])
        expect(b.status, b.out).toBe(1)
        expect(b.out).toContain(`A restore of ${firstBackup} did not finish`)
        expect(b.out).toContain(`restore.sh ${firstBackup}`)
        expect(readdirSync(BACKUPS)).not.toContain('half-restored-for-real')

        expectFinishedByRerun()
      } finally {
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // The first destructive statement: from here on nothing may be started again.
  it(
    'leaves the stack stopped when interrupted right after the DROP, and finishes when run again',
    () => {
      const stub = interruptAt('*"DROP DATABASE"*')
      let r: ScriptResult
      try {
        r = runScript('restore.sh', [firstBackup], {
          input: `${stamp()}\n`,
          env: { PATH: stub.path },
        })
      } finally {
        stub.remove()
      }
      try {
        expectLeftStopped(r, 'ClickHouse was being dropped and may be gone')
        expectFinishedByRerun()
      } finally {
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // A rerun after an interruption finds the earlier run's marker. If it cannot
  // write its own, the earlier one still describes the stores and must stay.
  it(
    'leaves an earlier marker as it was when it cannot write its own',
    () => {
      writeFileSync(MARKER, '/srv/backups/2026-10-01T041500Z\n')
      // A directory where the new marker is written first: the write fails for real.
      mkdirSync(`${MARKER}.partial`)
      try {
        const r = runScript('restore.sh', [firstBackup], { input: `${stamp()}\n` })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain(`Could not write ${MARKER}. Nothing has been changed yet.`)
        expect(r.out).not.toContain('stopped part way')
        expect(readFileSync(MARKER, 'utf8')).toBe('/srv/backups/2026-10-01T041500Z\n')
        expect(running()).toEqual(ALL_SERVICES)
        expect(existsSync(LOCK)).toBe(false)
      } finally {
        rmSync(`${MARKER}.partial`, { recursive: true, force: true })
        rmSync(MARKER, { force: true })
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )

  // Every store was restored and does not match the manifest: the stores are
  // not the backup's, so the marker stays and backups stay refused.
  it(
    'keeps the marker, and backups refused, when the restored stores do not match the manifest',
    () => {
      const dir = join(BACKUPS, 'copies', 'wrong-count')
      rmSync(dir, { recursive: true, force: true })
      cpSync(firstBackup, dir, { recursive: true })
      const path = join(dir, 'MANIFEST')
      const edited = readFileSync(path, 'utf8').replace(
        /^rows\.clickhouse\.clicks=\d+$/m,
        'rows.clickhouse.clicks=99',
      )
      expect(edited).not.toBe(readFileSync(path, 'utf8'))
      writeFileSync(path, edited)
      try {
        const r = runScript('restore.sh', [dir], { input: `${manifest(dir).timestamp}\n` })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('the restore failed during the verification step')
        expect(r.out).toContain('clicks: the backup recorded 99 rows')
        expect(readFileSync(MARKER, 'utf8')).toBe(`${dir}\n`)
        for (const s of APPS) expect(running(), s).not.toContain(s)

        const b = runScript('backup.sh', [join(BACKUPS, 'after-mismatch')])
        expect(b.status, b.out).toBe(1)
        expect(b.out).toContain(`A restore of ${dir} did not finish`)
        expect(readdirSync(BACKUPS)).not.toContain('after-mismatch')

        rmSync(MARKER, { force: true })
        expectFinishedByRerun()
      } finally {
        rmSync(MARKER, { force: true })
        rmSync(LOCK, { recursive: true, force: true })
      }
    },
    LONG,
  )
})

describe('a backup restored into an empty stack', () => {
  const NEW_ORDER = '/order-plz'
  const orders = (): number => compose('logs', '--no-color', 'pebble').split(NEW_ORDER).length - 1
  const OLD_ROOT = join(TMP, 'issuing-root-before-restore.pem')
  /** The same file as seen from a client container, which mounts TMP at /ca. */
  const OLD_ROOT_IN_CLIENT = '/ca/issuing-root-before-restore.pem'

  /**
   * The two newest migrations, undone by hand before the backup, so that the
   * backup is of an older schema than the image: the case of a backup taken
   * before an upgrade and restored after it. Newest first. 009 is one index;
   * 010 records when a domain's DNS check last passed.
   */
  const UNDONE = [9, 10]
  const UNDO = [
    // 010 adds one column and backfills it; dropping the column undoes both.
    'ALTER TABLE domain_dns_checks DROP COLUMN passed_at',
    // 009
    'DROP INDEX links_created_idx',
  ]
  /** One row each when 009's and 010's objects exist. */
  const EXISTS = [
    "SELECT count(*) FROM pg_indexes WHERE indexname = 'links_created_idx'",
    "SELECT count(*) FROM information_schema.columns WHERE table_name = 'domain_dns_checks' AND column_name = 'passed_at'",
  ]

  let base = 0
  let oldCookie = ''
  let restoreOut = ''
  let imageVersion = 0
  /** Postgres's clock just before every volume is destroyed. */
  let downAt = ''

  beforeAll(async () => {
    base = reportedClicks({ cookie })
    expect(base).toBe(2)
    // Read while the worker runs; the CLI is executed in its container.
    imageVersion = imageSchema()

    compose('stop', 'worker')
    for (let i = 0; i < 3; i++) click()
    await until('three clicks in sealed segments', 60_000, () => spoolLines() === 3)
    const shipped = segments().map((name) => ({
      name,
      body: compose('exec', '-T', 'redirect', 'cat', `${SPOOL}/${name}`),
    }))

    compose('start', 'worker')
    await until(
      'the three clicks in the reports',
      120_000,
      () => reportedClicks({ cookie }) === base + 3,
    )
    await until('the shipped segments deleted', 60_000, () => segments().length === 0)

    // The state a crash between ClickHouse accepting a segment and the worker
    // deleting it leaves: the same clicks in both places.
    compose('stop', 'worker')
    for (const s of shipped) {
      compose(
        'exec',
        '-T',
        '-e',
        `CM_BODY=${s.body}`,
        'redirect',
        'sh',
        '-c',
        'printf "%s" "$CM_BODY" > "$0"',
        `${SPOOL}/${s.name}`,
      )
    }
    click()
    click()
    await until('five click lines in sealed segments', 60_000, () => spoolLines() === 5)

    // Two migrations the backup will not have, and the image does.
    for (const sql of UNDO) pg(sql)
    pg(`DELETE FROM schema_migrations WHERE version IN (${UNDONE.join(', ')})`)
    for (const sql of EXISTS) expect(pg(sql), sql).toBe('0')

    const backup = runScript('backup.sh', [join(BACKUPS, 'round-trip')])
    if (backup.status !== 0) throw new Error(`backup failed:\n${backup.out}`)
    const dir = onlyBackupIn(join(BACKUPS, 'round-trip'))
    expect(running()).not.toContain('worker')
    expect(reportedClicks({ cookie })).toBe(base + 3)
    // Older than the image: the guard's `<` case, not only its `=` one.
    expect(Number(manifest(dir).schema_version)).toBe(imageVersion - UNDONE.length)

    copyFileSync(join(TMP, 'issuing-root.pem'), OLD_ROOT)
    oldCookie = cookie

    downAt = pg('SELECT now()')
    compose('down', '-v')
    writeAcmeRoot()
    publishZone()
    compose('up', '-d', '--wait', ...WAIT_TIMEOUT)
    root = writeIssuingRoot()
    // Empty: the worker has migrated fresh stores to the image's version, and
    // there is no link. Waited on the ledger reaching the image's version, not
    // on `links` existing: that table is migration 1, and ClickHouse's tables
    // come later in the same sequence.
    const target = String(imageVersion)
    await until('the empty stack migrated', 120_000, () => {
      try {
        return pg('SELECT max(version) FROM schema_migrations') === target
      } catch {
        return false
      }
    })
    expect(pg('SELECT count(*) FROM links')).toBe('0')
    expect(ch('SELECT count() FROM clicks')).toBe('0')
    // What the empty stack holds that the backup does not: a restore replaces
    // the spool and Caddy's data, it does not add to them.
    compose('exec', '-T', 'redirect', 'sh', '-c', 'echo stale > "$0/stale.bad"', SPOOL)
    compose('exec', '-T', 'caddy', 'sh', '-c', 'echo stale > /data/stale-before-restore')

    const restored = runScript('restore.sh', [dir], { input: `${manifest(dir).timestamp}\n` })
    restoreOut = restored.out
    if (restored.status !== 0) throw new Error(`restore failed:\n${restored.out}`)
  }, 1_500_000)

  // The store and the spool first, the report last: a certificate that did not
  // come back fails the report, and must not read as clicks that were lost.
  it(
    'counts every click once: those ClickHouse held, those only in the spool, and those in both',
    async () => {
      await until(
        'the restored spool shipped',
        120_000,
        () => num(ch('SELECT count() FROM clicks FINAL')) === base + 5,
      )
      await until('the spool emptied', 60_000, () => segments().length === 0)
      expect(num(ch('SELECT uniqExact(click_id) FROM clicks'))).toBe(base + 5)
      expect(num(ch('SELECT uniqExactMerge(clicks_state) FROM clicks_hourly'))).toBe(base + 5)
      expect(reportedClicks({ cookie: oldCookie, cacert: OLD_ROOT_IN_CLIENT })).toBe(base + 5)
    },
    LONG,
  )

  it(
    'serves the admin host the certificate it had, and asks the new authority for none',
    () => {
      const r = api('GET', '/api/me', { cookie: oldCookie, cacert: OLD_ROOT_IN_CLIENT })
      // The order first: a regression that orders and serves a new certificate
      // then names both symptoms, not only the failed handshake.
      expect(orders()).toBe(0)
      expect(r.exit, r.stderr).toBe(0)
    },
    LONG,
  )

  it(
    'brings back the account, the session signed in before the backup, and the link',
    () => {
      expect(api('GET', '/api/me', { cookie: oldCookie, cacert: OLD_ROOT_IN_CLIENT }).status).toBe(
        200,
      )
      expect(signIn(OLD_ROOT_IN_CLIENT).status).toBe(200)
      const r = curl(['-4', '--max-time', '30', '-D', '-', `http://${LINK_HOST}/${SLUG}`])
      expect(r.status).toBe(302)
      expect(r.headers).toMatch(new RegExp(`^location: ${TARGET}\\r?$`, 'im'))
    },
    LONG,
  )

  it(
    'applies, when the worker starts, the migrations the backup was missing',
    async () => {
      await until(
        'migrations 9 and 10 applied again',
        60_000,
        () =>
          pg(`SELECT count(*) FROM schema_migrations WHERE version IN (${UNDONE.join(', ')})`) ===
          String(UNDONE.length),
      )
      for (const sql of EXISTS) expect(pg(sql), sql).toBe('1')
      // The rest of the ledger is the backup's, written before the old stack
      // went down. The empty stack's worker wrote a whole ledger of its own
      // after that, and a restore that left it in place would list them all.
      expect(
        pg(
          `SELECT string_agg(version::text, ',' ORDER BY version) FROM schema_migrations WHERE applied_at > '${downAt}'`,
        ),
      ).toBe('9,10')
    },
    LONG,
  )

  it(
    'leaves the whole stack running, and nothing on the ClickHouse backups disk',
    () => {
      expect(running()).toEqual(ALL_SERVICES)
      expect(backupsDisk()).toBe('')
    },
    LONG,
  )

  it(
    'empties the spool and Caddy’s data before putting the backup’s back',
    () => {
      expect(compose('exec', '-T', 'redirect', 'ls', '-A', SPOOL)).not.toContain('stale.bad')
      expect(compose('exec', '-T', 'caddy', 'ls', '-A', '/data')).not.toContain(
        'stale-before-restore',
      )
    },
    LONG,
  )

  it(
    'tells the operator what a restore brought back that they may not want',
    () => {
      expect(restoreOut).toContain('A key revoked or a password changed')
      expect(restoreOut).toContain('apikey list')
    },
    LONG,
  )
})
