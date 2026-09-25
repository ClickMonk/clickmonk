/**
 * How fresh the numbers are, and how old the lists behind them.
 *
 * Three questions an operator cannot answer from a report: whether the newest
 * clicks have reached the rollups yet, how old the IP lists are that classified
 * them, and whether any domain needs attention. The interface shows all three
 * in its header, which is why they are one read and not three.
 *
 * **It answers when reporting does not.** A store that cannot be reached is a
 * `reporting: "unavailable"` in a 200, not a 503: this is the route that says
 * reporting is down, and it cannot do that by being down with it. The store is
 * read under the report gate like every other report, so a full gate is still a
 * 429 — that is the gate being busy, not the store being gone.
 *
 * The IP lists are read from the manifest the worker writes, through the one
 * reader of it every other service uses, on a volume this service mounts
 * read-only. What the manifest could not be read *because of* goes to the log
 * and never into the response, which would otherwise name a path on the host.
 */
import { DEFAULT_IPDATA_DIR, SOURCE_IDS, readManifest } from '@clickmonk/ipdata'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdminContext } from './app.js'
import { requireCredential } from './auth.js'
import { ALERT_CONDITION, MAX_DOMAINS_LISTED } from './domains.js'
import { HttpError } from './http.js'
import { chRows, newestHourOrNull, readQuery, withSlot } from './reports.js'

const StatusQuery = z.object({}).strict()

type SourceStatus = { version: string; fetchedAt: string } | null

function ipDataOf(
  dir: string,
  log: { error: (o: object, msg: string) => void },
): { ipData: Record<string, SourceStatus> | null; ipDataProblem: string | null } {
  try {
    const m = readManifest(dir)
    if (m === null) return { ipData: null, ipDataProblem: null }
    const out: Record<string, SourceStatus> = {}
    for (const id of SOURCE_IDS) {
      const s = m.sources[id]
      out[id] = s === undefined ? null : { version: s.version, fetchedAt: s.fetchedAt }
    }
    return { ipData: out, ipDataProblem: null }
  } catch (err) {
    log.error({ err }, 'the ip data manifest could not be read')
    return { ipData: null, ipDataProblem: 'the IP data manifest could not be read' }
  }
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/api/status', async (req) => {
    requireCredential(req)
    readQuery(StatusQuery, req.query)
    const alerts = await ctx.pg.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT 1 FROM domains d LEFT JOIN domain_dns_checks c ON c.domain_id = d.id
          WHERE ${ALERT_CONDITION}
          LIMIT ${MAX_DOMAINS_LISTED + 1}) AS a`,
    )
    const { ipData, ipDataProblem } = ipDataOf(ctx.ipdataDir ?? DEFAULT_IPDATA_DIR, req.log)
    const base = { ipData, ipDataProblem, alerts: Number(alerts.rows[0]?.n ?? 0) }
    if (!ctx.ch) {
      req.log.error('status was asked for but this service has no clickhouse client')
      return { newestHour: null, reporting: 'unavailable', ...base }
    }
    const ch = ctx.ch
    return withSlot(
      ctx.reportGate,
      { code: 'too_many_reports', message: 'too many reports at once; try again' },
      async () => {
        try {
          const [newest] = await chRows<{ newest: string }>({
            ch,
            req,
            query: 'SELECT toString(max(hour)) AS newest FROM clicks_hourly',
            params: {},
          })
          return { newestHour: newestHourOrNull(newest?.newest), reporting: 'ok', ...base }
        } catch (err) {
          // `chRows` has already logged the store's error and turned it into a
          // 503; here that 503 is the answer's content, not its status. Only
          // that failure is swallowed: anything else — a programming error in
          // the row mapping, say — is a real fault and must not read as
          // "reporting unavailable".
          if (!(err instanceof HttpError) || err.code !== 'reporting_unavailable') throw err
          return { newestHour: null, reporting: 'unavailable', ...base }
        }
      },
    )
  })
}
