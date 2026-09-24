/**
 * The install-wide traffic settings.
 *
 * Two rules the row itself teaches. **Every write upserts, in one statement**:
 * the row can be deleted by hand, every reader falls back to the defaults, and
 * an endpoint that assumed it exists would write nothing and report success —
 * while an insert *and* an update would fire this table's statement trigger
 * twice and make the redirect reload its whole snapshot for a second time. And
 * **what is read is validated**, not trusted: the column checks are looser
 * than `core` in places, so a row written by hand can be refused here and the
 * defaults reported instead, exactly as the redirect does with the row it
 * loads.
 */
import {
  DEFAULT_TRAFFIC_SETTINGS,
  type TrafficActions,
  type TrafficSettings,
  TrafficSettingsSchema,
} from '@clickmonk/core'
import type { FastifyInstance } from 'fastify'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { readBody } from './http.js'

interface SettingsRow {
  traffic_actions: TrafficActions
  safe_url: string | null
  abuser_threshold: number
}

const toSettings = (r: SettingsRow): TrafficSettings => ({
  actions: r.traffic_actions,
  safeUrl: r.safe_url,
  abuserThreshold: r.abuser_threshold,
})

/** What the redirect serves, and a note when that is not what is stored. */
export async function servedSettings(
  ctx: AdminContext,
): Promise<{ settings: TrafficSettings; problem: string | null }> {
  const r = await ctx.pg.query<SettingsRow>(
    'SELECT traffic_actions, safe_url, abuser_threshold FROM settings',
  )
  const row = r.rows[0]
  if (!row) {
    return {
      settings: DEFAULT_TRAFFIC_SETTINGS,
      problem: 'no settings are stored; the defaults apply',
    }
  }
  const parsed = TrafficSettingsSchema.safeParse(toSettings(row))
  if (parsed.success) return { settings: parsed.data, problem: null }
  const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return {
    settings: DEFAULT_TRAFFIC_SETTINGS,
    problem: `the stored settings are invalid (${why}); the defaults apply`,
  }
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/settings', async (req) => {
    requireCredential(req)
    const { settings, problem } = await servedSettings(ctx)
    return { ...settings, problem }
  })

  /**
   * The whole object, not a patch: the safe action and the safe URL depend on
   * each other, and a partial write is how a link ends up set to `safe` with
   * nowhere to send a click. `core`'s schema refuses that pair, and the
   * column's own CHECK refuses it again.
   */
  app.put('/api/settings', async (req) => {
    requireCredential(req)
    const next = readBody(TrafficSettingsSchema, req.body)
    // One statement, because `settings` fires `config_changed` from a
    // statement trigger: an insert followed by an update would make the
    // redirect reload its whole snapshot twice for one write. The row can have
    // been deleted by hand, so this upserts rather than assuming it is there —
    // an UPDATE alone would match nothing and report success.
    await ctx.pg.query(
      `INSERT INTO settings (id, traffic_actions, safe_url, abuser_threshold, updated_at)
       VALUES (true, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET traffic_actions = EXCLUDED.traffic_actions, safe_url = EXCLUDED.safe_url,
             abuser_threshold = EXCLUDED.abuser_threshold, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(next.actions), next.safeUrl, next.abuserThreshold, ctx.now()],
    )
    return { ...next, problem: null }
  })
}
