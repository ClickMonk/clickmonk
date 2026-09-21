import type { Pool } from '@clickmonk/db'

export const CAP_TIMEOUT_MS = 150

type CapResult = 'ok' | 'exhausted' | 'unchecked'

/**
 * One atomic statement: insert the first click, or increment while under the
 * cap. When the cap is reached the WHERE on the conflict update fails and no
 * row comes back. Postgres serialises concurrent upserts on the same key, so
 * exactly `cap` calls return 'ok'.
 *
 * Never rejects, and never takes longer than `timeoutMs`: the wait for a pool
 * connection and the query race one timer together. Any error or timeout is
 * 'unchecked' and the redirect fails open, because turning away paid traffic
 * over a slow database is the worse failure. A query that loses the race may
 * still commit afterwards; that click then counts toward the cap although it
 * was recorded as unchecked.
 */
export async function tryConsumeCap(
  pool: Pool,
  linkId: string,
  cap: number,
  timeoutMs = CAP_TIMEOUT_MS,
): Promise<CapResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<CapResult>((resolve) => {
    timer = setTimeout(() => resolve('unchecked'), timeoutMs)
  })
  try {
    return await Promise.race([consume(pool, linkId, cap), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function consume(pool: Pool, linkId: string, cap: number): Promise<CapResult> {
  try {
    const r = await pool.query(
      `INSERT INTO link_counters (link_id, clicks) VALUES ($1, 1)
       ON CONFLICT (link_id) DO UPDATE SET clicks = link_counters.clicks + 1
        WHERE link_counters.clicks < $2
       RETURNING clicks`,
      [linkId, cap],
    )
    return r.rowCount === 1 ? 'ok' : 'exhausted'
  } catch {
    return 'unchecked'
  }
}
