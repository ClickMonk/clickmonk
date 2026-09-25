/**
 * The install-wide settings: the traffic actions the redirect evaluates with,
 * and how long this install keeps what it records.
 *
 * The row is read and written by one function shared with the command line and
 * the retention pass, so the fallback rule — what a missing or unreadable row
 * means — exists once. What stays here is how this surface answers it.
 *
 * **The whole object, never a patch.** The safe action and the safe URL depend
 * on each other, and a partial write is how a link ends up set to `safe` with
 * nowhere to send a click. The two halves arrive nested because each is
 * validated by its own strict schema.
 */
import { type InstallSettings, InstallSettingsSchema, retentionNote } from '@clickmonk/core'
import { SettingsLockedError, readSettings, writeSettings } from '@clickmonk/worker/settings'
import type { FastifyInstance } from 'fastify'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { fail, readBody } from './http.js'

function body(s: InstallSettings, problem: string | null): Record<string, unknown> {
  return { traffic: s.traffic, retention: s.retention, note: retentionNote(s.retention), problem }
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/settings', async (req) => {
    requireCredential(req)
    const read = await readSettings(ctx.pg)
    // Retention comes back null when the stored row cannot be read as
    // retention at all, and that is reported as it is rather than as the
    // defaults: the pass deletes nothing while it is in that state, and an
    // operator shown "90 days" would have no way to tell.
    return {
      traffic: read.traffic,
      retention: read.retention,
      note: read.retention === null ? null : retentionNote(read.retention),
      problem: read.problem,
    }
  })

  app.put('/api/settings', async (req) => {
    requireCredential(req)
    const next = readBody(InstallSettingsSchema, req.body)
    try {
      await writeSettings(ctx.pg, next, ctx.now())
    } catch (err) {
      // The retention pass holds this row while it deletes, and the writer stops
      // waiting rather than holding a request open for the length of a pass.
      // 503 with `retry-after`, because nothing is wrong with the request and
      // sending it again is the whole remedy. `return fail(…)`: a bare call does
      // not tell the compiler this path ends.
      if (err instanceof SettingsLockedError) {
        return fail(503, 'settings_locked', err.message, { 'retry-after': '5' })
      }
      throw err
    }
    return body(next, null)
  })
}
