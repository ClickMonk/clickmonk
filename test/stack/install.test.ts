import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT, sleep } from './stack.js'

const SCRIPT = join(ROOT, 'install.sh')
/** A real bash 3.2, pinned: the version macOS ships, and the oldest this script supports. */
const BASH32_IMAGE = 'bash:3.2.57'
const KEYS = ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'CLICKMONK_SECRET']
/**
 * Run a container as whoever is running this suite. A container defaults to
 * root, so what it writes into a mounted directory lands root-owned, and a
 * non-root run of this suite then cannot read back the file it asserts on —
 * `EACCES` on a directory it created itself. `-1:-1` is refused by Docker
 * rather than quietly falling back to root.
 */
const AS_US = ['--user', `${process.getuid?.() ?? -1}:${process.getgid?.() ?? -1}`]

// Every test gets its own copy of the script in its own empty directory. The
// script writes .env beside itself and this repository's own .env is not the
// suite's to touch; and a test that started from a directory an earlier test
// had already written .env into would never cover the branch that writes it.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clickmonk-install-'))
  copyFileSync(SCRIPT, join(dir, 'install.sh'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = (...args: string[]) =>
  spawnSync(join(dir, 'install.sh'), args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

/** The same, on a host whose PATH is exactly `path`. */
const runPath = (path: string, ...args: string[]) =>
  spawnSync(join(dir, 'install.sh'), args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, PATH: path },
  })

/** The same, with `bin` first on this host's PATH, so its stubs are what those commands mean. */
const runWith = (bin: string, ...args: string[]) =>
  runPath(`${bin}:${process.env.PATH ?? ''}`, ...args)

/** A directory holding one executable stub, to put first on PATH. */
function stub(name: string, body: string): string {
  const bin = join(dir, `stub-${name}`)
  mkdirSync(bin)
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

const settingOf = (env: string, key: string): string =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1] ?? ''

/** Every file the script has written or is part way through writing. */
const envFiles = (): string[] => readdirSync(dir).filter((f) => f.startsWith('.env'))

/** The permission bits of `path`, or undefined once it is gone (it was renamed). */
function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

/**
 * A directory of symlinks to everything on the real PATH except `docker`, so a
 * PATH of just this directory is this host with Docker uninstalled and nothing
 * else missing. A list of the commands the script happens to use today would
 * make any later change to it look like a failure of this test.
 */
function pathWithoutDocker(parent: string): string {
  // Without a docker to leave out, this builds the host it already ran on and
  // the case it means to cover is not the case it runs.
  expect(
    spawnSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).status,
    'this host has no docker to leave out',
  ).toBe(0)
  const bin = join(parent, 'nodocker')
  mkdirSync(bin)
  const seen = new Set<string>()
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (entry === '') continue
    let names: string[]
    try {
      names = readdirSync(entry)
    } catch {
      continue // a PATH entry that does not exist, which is normal
    }
    for (const name of names) {
      // Earlier entries win, as they do on a real PATH.
      if (name.startsWith('docker') || seen.has(name)) continue
      seen.add(name)
      symlinkSync(join(entry, name), join(bin, name))
    }
  }
  return bin
}

describe('install.sh', () => {
  it('writes .env readable by nobody else, with a secret of its own for each', () => {
    const r = run('--no-start')
    expect(r.status, r.stderr).toBe(0)
    const env = readFileSync(join(dir, '.env'), 'utf8')
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    const values = KEYS.map((k) => settingOf(env, k))
    for (const v of values) expect(v).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(values).size).toBe(3)
    // The one setting the installer writes with no value, so an operator finds
    // it where the others are rather than only in .env.example.
    expect(env, 'the optional setting the installer writes empty').toMatch(
      /^CLICKMONK_ADMIN_HOST=$/m,
    )
  })

  // The run that generates the secrets is the run that could print one, and in
  // this directory the first run is that run.
  it('never prints one of them, on the run that writes them or a later one', () => {
    const writing = run('--no-start')
    expect(writing.status, writing.stderr).toBe(0)
    const env = readFileSync(join(dir, '.env'), 'utf8')
    const later = run('--no-start')
    expect(later.status, later.stderr).toBe(0)
    const runs: Array<[string, typeof writing]> = [
      ['the run that wrote them', writing],
      ['a later run', later],
    ]
    for (const [what, r] of runs) {
      const printed = `${r.stdout}${r.stderr}`
      for (const k of KEYS) expect(printed, `${k}, ${what}`).not.toContain(settingOf(env, k))
    }
  })

  // The window between the file appearing and its mode being right is
  // microseconds, so `od` — what turns the random bytes into hex, inside the
  // redirect that creates the file — is slowed down to make it observable.
  it('never leaves the file readable by anyone else while it is being written', async () => {
    const realOd = execFileSync('/bin/sh', ['-c', 'command -v od'], { encoding: 'utf8' }).trim()
    const bin = stub('od', `sleep 1\nexec ${realOd} "$@"`)
    const child = spawn(join(dir, 'install.sh'), ['--no-start'], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
    const modes: number[] = []
    const deadline = Date.now() + 60_000
    while (child.exitCode === null) {
      for (const f of envFiles()) {
        const mode = modeOf(join(dir, f))
        if (mode !== undefined) modes.push(mode)
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error('the script never finished')
      }
      await sleep(10)
    }
    expect(await exited).toBe(0)
    expect(modes.length, 'the file was never seen while it was being written').toBeGreaterThan(0)
    for (const mode of modes) {
      expect(mode & 0o077, `mode 0${mode.toString(8)} while the passwords were in it`).toBe(0)
    }
  })

  it('changes nothing on a second run, so re-running is safe', () => {
    expect(run('--no-start').status).toBe(0)
    const before = readFileSync(join(dir, '.env'), 'utf8')
    const r = run('--no-start')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('leaving every value in it alone')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before)
  })

  // A value that is not 32 bytes of hex means the random source or one of the
  // commands that formats it misbehaved. The file is put in place by one
  // rename after that check, so a run that stops here leaves nothing: no .env
  // for the next run to keep as it is, and no half-written file beside it.
  it('writes nothing when a value comes out malformed', () => {
    const r = runWith(stub('od', 'echo "zz zz"'), '--no-start')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not give 32 bytes of hex')
    expect(envFiles(), 'it left a file behind').toEqual([])
  })

  it('explains itself and refuses an option it does not know', () => {
    expect(run('--help').stdout).toContain('--no-start')
    const bad = run('--nonsense')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('unknown option')
  })

  // --no-start starts nothing, so it must not fail on a Docker that cannot be
  // used yet, or on one that is not there at all. Writing the secrets first and
  // installing Docker afterwards is a normal order, and the usage text promises
  // this works.
  it('writes .env without a usable docker, because --no-start starts nothing', () => {
    // Both hosts, because each one decides a different check. A `docker` that
    // only fails when it runs satisfies `command -v docker`, so with that host
    // alone the "is it installed" check could move onto the --no-start path
    // unnoticed; on a host with no `docker` at all, the `docker compose
    // version` check is never the one that refuses.
    const hosts: Array<[string, string]> = [
      ['docker installed and unusable', `${stub('docker', 'exit 1')}:${process.env.PATH ?? ''}`],
      ['docker not installed', pathWithoutDocker(dir)],
    ]
    for (const [host, path] of hosts) {
      rmSync(join(dir, '.env'), { force: true })
      const r = runPath(path, '--no-start')
      expect(r.status, `${host}: ${r.stderr}`).toBe(0)
      expect(readFileSync(join(dir, '.env'), 'utf8'), host).toMatch(
        /^CLICKMONK_SECRET=[0-9a-f]{64}$/m,
      )
    }
  })

  // macOS still ships bash 3.2, and an operator's first command is this one.
  it('uses nothing bash 3.2 does not have', () => {
    // Comments are stripped first: this script's own header names some of
    // these constructs in order to say it does not use them.
    const src = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    for (const construct of [
      /\bmapfile\b/,
      /\breadarray\b/,
      /declare\s+-A/,
      /local\s+-A/,
      /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?/,
      /\$\{[A-Za-z_][A-Za-z0-9_]*,,?/,
      /&>>/,
      /;;&/,
    ]) {
      expect(src, `${construct}`).not.toMatch(construct)
    }
    expect(execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).toBe('')
  })

  // The list above only covers what somebody thought to list. This runs the
  // thing under the real shell, which covers the rest. Kept alongside the
  // list, which reaches constructs a --no-start run never gets to.
  it('runs under a real bash 3.2', () => {
    const version = execFileSync(
      'docker',
      ['run', '--rm', ...AS_US, BASH32_IMAGE, 'bash', '-c', 'echo $BASH_VERSION'],
      { encoding: 'utf8', timeout: 60_000 },
    )
    expect(version, 'the pinned image is not bash 3.2').toMatch(/^3\.2\./)
    // Writable, unlike the mount `pnpm lint:sh` uses: this run writes .env.
    const r = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        ...AS_US,
        '-v',
        `${dir}:/mnt`,
        '-w',
        '/mnt',
        BASH32_IMAGE,
        'bash',
        'install.sh',
        '--no-start',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toBe('')
    // Read back from the host, as every other test here does, which is only
    // possible because the run wrote as us: see AS_US.
    const written = statSync(join(dir, '.env'))
    expect(written.uid, 'the container wrote .env as somebody else').toBe(process.getuid?.() ?? -1)
    expect(written.mode & 0o777).toBe(0o600)
    const env = readFileSync(join(dir, '.env'), 'utf8')
    for (const k of KEYS) expect(settingOf(env, k), k).toMatch(/^[0-9a-f]{64}$/)
  })
})
