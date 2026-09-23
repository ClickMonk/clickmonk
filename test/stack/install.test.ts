import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT } from './stack.js'

const SCRIPT = join(ROOT, 'install.sh')

let dir: string
const run = (...args: string[]) =>
  spawnSync(join(dir, 'install.sh'), args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

beforeAll(() => {
  // A copy, not the repository: the script writes .env beside itself, and
  // this repository's own .env is not the suite's to touch.
  dir = mkdtempSync(join(tmpdir(), 'clickmonk-install-'))
  copyFileSync(SCRIPT, join(dir, 'install.sh'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const settingOf = (env: string, key: string): string =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1] ?? ''

/**
 * A directory holding only the commands the script needs to write .env, so a
 * PATH of just this directory is a host where Docker is not installed. A
 * command it needs and this misses fails the run rather than passing it, which
 * is what this fixture wants: nothing here quietly stands in for `docker`.
 */
function binWithoutDocker(parent: string): string {
  const bin = join(parent, 'nodocker')
  mkdirSync(bin)
  for (const tool of ['bash', 'cat', 'dirname', 'head', 'od', 'tr']) {
    const real = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    symlinkSync(real, join(bin, tool))
  }
  return bin
}

describe('install.sh', () => {
  it('writes .env readable by nobody else, with a secret of its own for each', () => {
    const r = run('--no-start')
    expect(r.status, r.stderr).toBe(0)
    const env = readFileSync(join(dir, '.env'), 'utf8')
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    const values = ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'CLICKMONK_SECRET'].map((k) =>
      settingOf(env, k),
    )
    for (const v of values) expect(v).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(values).size).toBe(3)
  })

  it('never prints one of them', () => {
    const env = readFileSync(join(dir, '.env'), 'utf8')
    const r = run('--no-start')
    const printed = `${r.stdout}${r.stderr}`
    for (const k of ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'CLICKMONK_SECRET']) {
      expect(printed, k).not.toContain(settingOf(env, k))
    }
  })

  it('changes nothing on a second run, so re-running is safe', () => {
    const before = readFileSync(join(dir, '.env'), 'utf8')
    const r = run('--no-start')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('leaving every value in it alone')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before)
  })

  it('explains itself and refuses an option it does not know', () => {
    expect(run('--help').stdout).toContain('--no-start')
    const bad = run('--nonsense')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('unknown option')
  })

  // --no-start starts nothing, so it must not fail on a Docker that cannot
  // be used yet, or on one that is not there at all. Writing the secrets first
  // and installing Docker afterwards is a normal order, and the usage text
  // promises this works.
  it('writes .env without a usable docker, because --no-start starts nothing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'clickmonk-install-nodocker-'))
    try {
      copyFileSync(SCRIPT, join(bare, 'install.sh'))
      const bin = join(bare, 'bin')
      mkdirSync(bin)
      // First on PATH, so this is what `docker` means for that run.
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      // Both hosts, because each one decides a different check. A `docker`
      // that only fails when it runs satisfies `command -v docker`, so with
      // that host alone the "is it installed" check could move onto the
      // --no-start path unnoticed; on a host with no `docker` at all, the
      // `docker compose version` check is never the one that refuses.
      const hosts: Array<[string, string]> = [
        ['docker installed and unusable', `${bin}:${process.env.PATH ?? ''}`],
        ['docker not installed', binWithoutDocker(bare)],
      ]
      for (const [host, path] of hosts) {
        rmSync(join(bare, '.env'), { force: true })
        const r = spawnSync(join(bare, 'install.sh'), ['--no-start'], {
          cwd: bare,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PATH: path },
        })
        expect(r.status, `${host}: ${r.stderr}`).toBe(0)
        expect(readFileSync(join(bare, '.env'), 'utf8'), host).toMatch(
          /^CLICKMONK_SECRET=[0-9a-f]{64}$/m,
        )
      }
    } finally {
      rmSync(bare, { recursive: true, force: true })
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
})
