import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { SCHEMA_VERSION, VERSION } from '@clickmonk/core'
import { describe, expect, it } from 'vitest'

// Runs the built entry point, not commands.ts directly: the guard this pins
// is in index.ts, before runCli is ever called, so importing commands.ts
// would not exercise it.
const DIST = join(import.meta.dirname, '..', 'dist', 'index.js')

function runVersion(env: NodeJS.ProcessEnv): {
  status: number | null
  stdout: string
  stderr: string
} {
  const r = spawnSync('node', [DIST, 'version'], { encoding: 'utf8', env })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('the entry point', () => {
  // A backup script runs `version` in a one-off container to learn an
  // image's schema version before any database in the install is known to
  // be reachable — the variable every other command requires up front must
  // not be asked for here.
  it('answers version with no CLICKMONK_POSTGRES_URL set', () => {
    const r = runVersion({ PATH: process.env.PATH })
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe(`clickmonk ${VERSION} (schema version ${SCHEMA_VERSION})\n`)
    expect(r.status).toBe(0)
  })

  // The same container's own CLICKMONK_DNS_SERVERS can be malformed; that
  // must not stop `version` from answering either.
  it('answers version even when CLICKMONK_DNS_SERVERS is malformed', () => {
    const r = runVersion({ PATH: process.env.PATH, CLICKMONK_DNS_SERVERS: 'not-a-resolver' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe(`clickmonk ${VERSION} (schema version ${SCHEMA_VERSION})\n`)
    expect(r.status).toBe(0)
  })
})
