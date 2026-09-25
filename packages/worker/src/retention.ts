/**
 * Deleting what this install said it would stop keeping.
 *
 * Two jobs, on their own periods. Raw clicks past the raw period are dropped a
 * whole partition at a time; the address on a click past the address period is
 * blanked in place. Rollups are never touched — they are small, and they are
 * what answers a question older than the raw window.
 *
 * **A period is a floor, not a promise.** `clicks` is partitioned by month, so
 * a partition can only go once its last possible row is past the period: with
 * ninety days an install keeps between ninety and a hundred and twenty-one
 * days, and with thirty days of addresses it keeps them between thirty and
 * sixty-one. Partitioning by day to tighten that would multiply the part count
 * by thirty on the one table that grows without bound, and a row-level delete
 * is a mutation — the expensive way to do what dropping a partition does for
 * nothing.
 *
 * **Blanking is a mutation, so it is issued once.** A mutation rewrites the
 * parts it touches, and re-issuing one every hour would rewrite a month of
 * data every hour for ever. What decides whether to issue it is the condition
 * itself — is there still a row in this partition with an address — rather than
 * a record of what has been blanked, because a record is state that can
 * disagree with the data it describes. And nothing is issued while a mutation
 * is still running on the table, or a month that takes twenty minutes to
 * rewrite would collect a new mutation every hour.
 *
 * **A pass is bounded by the work it does, never by where that work sits.** The
 * bound below is on partitions acted on, and what fills it is chosen by asking
 * which partitions still need something done to them — not by taking the oldest
 * few. Taking the oldest few is correct only while the oldest keep being
 * dropped, which is what would make the window advance; with no raw period at
 * all, or a raw period longer than the bound's worth of months, nothing is ever
 * dropped, the same oldest months are considered every hour, and every month
 * behind them keeps its addresses for ever while the pass logs a success. That
 * is the ledger's failure reached from the other end, so the selection is the
 * condition too: the months past the address cutoff that still hold an address,
 * asked for in one statement rather than one per partition, because a probe per
 * partition is itself work that grows with the months this install has kept.
 *
 * **A partition id is the one value in this codebase that reaches SQL as
 * text.** DDL takes no bound parameters. So the id has to come from
 * ClickHouse's own `system.parts`, never from anything a request can reach, and
 * it is put through `partitionEndMs` first — which returns null for anything
 * that is not a month this table's partition key could have produced. An id
 * that fails is logged and skipped.
 *
 * **When the stored retention cannot be read, this does nothing.** A default
 * is a safe answer when the thing it stands in for is an action; a retention
 * default deletes clicks. It is the only default in this product that does.
 *
 * **And the read is held under the settings row's lock for the whole pass**,
 * which is the same lock a settings write takes. Nothing can span both stores,
 * so without it an operator who sets a period to `never` — or deletes the row —
 * a moment after the read has it enforced anyway, once, by a pass that read it
 * as ninety days. The cost is that a settings write waits for a pass in
 * flight, which is the DDL for at most one pass's worth of partitions.
 *
 * **Which is why every statement here is bounded.** A row lock held across
 * calls to another store is a lock that store can hold open: a ClickHouse that
 * accepts the connection and then stops answering would leave this transaction
 * open for as long as it stayed that way, with an operator's `settings set`
 * waiting behind it. So each statement carries `max_execution_time`, the
 * worker's client carries a request timeout longer than that, and the settings
 * writers carry a lock timeout of their own — the operator is told to try
 * again rather than left holding a command that has printed nothing.
 */
import { checkIntervalMs } from '@clickmonk/core'
import type { ClickHouseClient, Pool, PoolClient } from '@clickmonk/db'
import { readSettingsLocked } from './settings.js'

/**
 * Partitions one pass acts on — dropped or blanked — oldest first. Two years of
 * months, so an install that has fallen behind catches up over a few hours
 * rather than issuing every mutation it owes at once.
 *
 * It is a bound on work and not on position: a partition this pass decides needs
 * nothing done to it does not fill it.
 */
export const RETENTION_PARTITIONS_PER_PASS = 24

/**
 * The server-side bound on one statement of a pass, in seconds.
 *
 * Under the worker's own request timeout, so a statement ClickHouse itself ends
 * comes back as ClickHouse's error rather than as a client-side abort with
 * nothing in it. It is the inner half of what keeps the settings row's lock from
 * being held by a store that has stopped answering; the client timeout is the
 * outer half, and it covers whatever a server-side bound does not.
 */
export const RETENTION_MAX_EXECUTION_SECONDS = 20

/**
 * Sent with every statement this pass issues. One object, so that adding a
 * statement without the bound is a visible omission rather than a default.
 */
const BOUND = { max_execution_time: RETENTION_MAX_EXECUTION_SECONDS } as const

const DAY_MS = 86_400_000
const PARTITION_ID = /^(\d{4})(\d{2})$/

/**
 * The first instant after the month a partition id names, or null when the id
 * is not one this table's `toYYYYMM(time)` key could have produced.
 *
 * `Date.UTC(year, month)` with a one-based month is the first instant of the
 * month after it, December included, because the month argument is zero-based
 * and rolls over on its own.
 */
export function partitionEndMs(id: string): number | null {
  const m = PARTITION_ID.exec(id)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return Date.UTC(year, month, 1)
}

export interface RetentionResult {
  /** Partition ids dropped, oldest first. */
  dropped: string[]
  /** Partition ids whose address column was blanked this pass. */
  blanked: string[]
  /** Partition ids this pass refused to name in a statement. */
  skipped: string[]
  /** True when a mutation was already running, so nothing was blanked. */
  mutationInFlight: boolean
  /** True when the stored retention could not be read and the pass did nothing. */
  ranNothing: boolean
}

const empty = (over: Partial<RetentionResult> = {}): RetentionResult => ({
  dropped: [],
  blanked: [],
  skipped: [],
  mutationInFlight: false,
  ranNothing: false,
  ...over,
})

async function scalar(
  ch: ClickHouseClient,
  query: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  const rs = await ch.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: BOUND,
  })
  const rows = await rs.json<{ n: string }>()
  return Number(rows[0]?.n ?? 0)
}

/** Every active partition of `clicks`, oldest first. */
async function partitionsOfClicks(ch: ClickHouseClient): Promise<string[]> {
  const rs = await ch.query({
    query: `SELECT DISTINCT partition_id FROM system.parts
             WHERE database = currentDatabase() AND table = 'clicks' AND active
             ORDER BY partition_id`,
    format: 'JSONEachRow',
    clickhouse_settings: BOUND,
  })
  return (await rs.json<{ partition_id: string }>()).map((r) => r.partition_id)
}

/**
 * The partitions among `ids` that still hold an address, oldest first.
 *
 * One statement for the whole set rather than one per partition, and it is the
 * condition itself — not a record of what has been blanked. A `_partition_id`
 * filter prunes to those partitions, and the only rows the aggregation sees are
 * the ones that still carry an address, so a month already blanked costs the read
 * of a column of empty strings and nothing else.
 *
 * No `FINAL`, unlike every other raw read in this service, and that is
 * deliberate: this is an existence question, and a duplicate row still means
 * there is an address in this partition. A dedup would cost a merge to answer a
 * question that does not need one.
 */
async function partitionsHoldingAddress(ch: ClickHouseClient, ids: string[]): Promise<Set<string>> {
  const rs = await ch.query({
    query: `SELECT DISTINCT _partition_id AS p FROM clicks
             WHERE ip != '' AND _partition_id IN {ids:Array(String)}`,
    query_params: { ids },
    format: 'JSONEachRow',
    clickhouse_settings: BOUND,
  })
  return new Set((await rs.json<{ p: string }>()).map((r) => r.p))
}

export interface RetentionOptions {
  pg: Pool
  ch: ClickHouseClient
  now: Date
  /** Partitions this pass may act on. Defaults to `RETENTION_PARTITIONS_PER_PASS`. */
  maxPartitions?: number
  /** A seam for the list of partitions only, so a test can reach the skip branch. */
  partitionSource?: () => Promise<string[]>
  log?: (msg: string, err?: unknown) => void
}

/**
 * One pass. Opens a transaction on Postgres, reads the retention under the
 * settings row's lock, and holds it until the deleting is done.
 */
export async function runRetention(o: RetentionOptions): Promise<RetentionResult> {
  const log = o.log ?? (() => {})
  const client = await o.pg.connect()
  try {
    await client.query('BEGIN')
    const result = await pass(o, client, log)
    await client.query('COMMIT')
    return result
  } catch (err) {
    // Every exit path ends the transaction before the client goes back to the
    // pool, and the lock goes with it: a client released mid-transaction is a
    // row lock nothing will ever release and a settings write that hangs.
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function pass(
  o: RetentionOptions,
  client: PoolClient,
  log: (msg: string, err?: unknown) => void,
): Promise<RetentionResult> {
  const read = await readSettingsLocked(client)
  // On `retention`, never on `problem`: a missing row and an unreadable one are
  // deliberately the same state here, so there is one branch and no second
  // path to get wrong. `problem` only says which it was.
  if (read.retention === null) {
    log(`retention is not running: ${read.problem ?? 'the stored retention cannot be read'}`)
    return empty({ ranNothing: true })
  }
  const { rawRetentionDays, ipRetentionDays } = read.retention
  // Both null is an answer — keep both for ever — and not the same as the
  // branch above. The two are one `??` apart.
  if (rawRetentionDays === null && ipRetentionDays === null) return empty()

  const nowMs = o.now.getTime()
  const rawCutoff = rawRetentionDays === null ? null : nowMs - rawRetentionDays * DAY_MS
  const ipCutoff = ipRetentionDays === null ? null : nowMs - ipRetentionDays * DAY_MS

  const all = await (o.partitionSource ?? (() => partitionsOfClicks(o.ch)))()
  const budget = o.maxPartitions ?? RETENTION_PARTITIONS_PER_PASS

  const result = empty()
  // Oldest first, and only the ids this table's own partition key could have
  // produced. An id that is not a month is skipped here whatever the budget is:
  // the budget bounds statements, and this decides never to write one.
  const months: { id: string; end: number }[] = []
  for (const id of all) {
    const end = partitionEndMs(id)
    if (end === null) {
      result.skipped.push(id)
      log(`skipped partition ${id}: not a month this table could have produced`)
      continue
    }
    months.push({ id, end })
  }

  // The drop is checked first: a partition past both periods goes whole rather
  // than being rewritten and then dropped. A drop needs no condition asked of
  // the store — the partition is either past the period or it is not — and it
  // takes the oldest of them because dropping is what makes the list shrink.
  const toDrop = rawCutoff === null ? [] : months.filter((m) => m.end <= rawCutoff)
  for (const m of toDrop.slice(0, budget)) {
    await o.ch.command({
      query: `ALTER TABLE clicks DROP PARTITION ID '${m.id}'`,
      clickhouse_settings: BOUND,
    })
    result.dropped.push(m.id)
  }

  const dropped = new Set(result.dropped)
  // Past the address period, and not one this pass has just dropped whole. A
  // partition the budget did not reach is left in, so the next pass sees it
  // again: it is a candidate because of where it sits in time, never because of
  // what an earlier pass did or did not get to.
  const candidates =
    ipCutoff === null
      ? []
      : months.filter((m) => m.end <= ipCutoff && !dropped.has(m.id)).map((m) => m.id)
  const left = budget - result.dropped.length

  if (candidates.length > 0 && left > 0) {
    const running = await scalar(
      o.ch,
      `SELECT count() AS n FROM system.mutations
        WHERE database = currentDatabase() AND table = 'clicks' AND NOT is_done`,
    )
    if (running > 0) {
      result.mutationInFlight = true
      log(`${running} mutation(s) still running on clicks; no addresses blanked this pass`)
    } else {
      // **This is why the selection is not a ledger.** A spool segment shipped
      // late lands in whichever month its clicks happened in, which can be a
      // month this pass has already blanked. The condition sees the address that
      // arrived and blanks it on the next pass. A record of partitions already
      // done would say that month was finished and leave that address in place
      // for ever, which is the one outcome this whole module exists to prevent —
      // and so would a bound that only ever looked at the oldest months, which
      // is the same failure with the ledger implied by the arithmetic.
      const holding = await partitionsHoldingAddress(o.ch, candidates)
      for (const id of candidates.filter((c) => holding.has(c)).slice(0, left)) {
        await o.ch.command({
          query: `ALTER TABLE clicks UPDATE ip = '' IN PARTITION ID '${id}' WHERE ip != ''`,
          clickhouse_settings: BOUND,
        })
        result.blanked.push(id)
      }
    }
  }

  log(
    `retention: dropped ${result.dropped.length}, blanked ${result.blanked.length}, skipped ${result.skipped.length}`,
  )
  return result
}

/**
 * Runs it every interval, starting at once. The returned promise of `stop()`
 * resolves after the pass in flight. Never rejects: a pass that throws is
 * logged and the next one is tried, because the alternative is a worker that
 * stops deleting and never says so.
 */
export function startRetention(o: {
  pg: Pool
  ch: ClickHouseClient
  intervalMs?: number
  now?: () => Date
  log?: (msg: string, err?: unknown) => void
}): { stop(): Promise<void> } {
  // Against what a timer can hold, here and not only in the configuration
  // schema: an interval past `setTimeout`'s 32-bit ceiling is not clamped, it is
  // replaced by 1 ms, and a monthly pass then runs a hundred and seventy times a
  // second — each one taking the settings row's lock.
  const interval = checkIntervalMs('intervalMs', o.intervalMs ?? 3_600_000)
  const now = o.now ?? (() => new Date())
  const log = (msg: string, err?: unknown) => {
    try {
      o.log?.(msg, err)
    } catch {
      // A broken logger must not stop the pass.
    }
  }
  let stopped = false
  let wake: (() => void) | null = null

  const loop = (async () => {
    while (!stopped) {
      try {
        await runRetention({ pg: o.pg, ch: o.ch, now: now(), log })
      } catch (err) {
        log('retention failed; will try again', err)
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = null
    }
  })()

  return {
    async stop() {
      stopped = true
      wake?.()
      await loop
    },
  }
}
