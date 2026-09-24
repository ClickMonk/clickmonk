import type { ClickHouseClient, Pool } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { partitionEndMs, runRetention, startRetention } from './retention.js'

const pool: Pool = testPg()
/**
 * A second pool, for the two tests that have to ask a question from outside
 * the connection the pass is using — which is what an operator's own
 * `settings set` is. Asking through `pool` risks asking on the pass's own
 * client, and a connection cannot notice that it is itself the problem.
 */
const operators: Pool = testPg()
const ch: ClickHouseClient = testCh()

/**
 * The instant every pass below is run at. Fixed, and the fixtures are fixed
 * around it, because the whole of this module is arithmetic on months and a
 * fixture relative to the real now would cross a month boundary and change
 * which partitions the answer names.
 */
const NOW = new Date('2026-09-24T12:00:00.000Z')

const click = (id: string, time: string, ip: string): Record<string, unknown> => ({
  click_id: id,
  time,
  host: 'go.example.test',
  path: '/a',
  domain_id: '00000000-0000-4000-8000-00000000000d',
  link_id: '00000000-0000-4000-8000-0000000000a1',
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/',
  target_id: '',
  visitor_id: 'v1',
  returning: 0,
  country: 'DE',
  region: '',
  city: '',
  geo_source: 'dbip',
  device: 'desktop',
  user_agent: 'ua',
  referrer: '',
  ip,
  cap_unchecked: 0,
  traffic_class: 'human',
  signals: [],
  action: '',
  os: 'windows',
  browser: 'chrome',
  asn: 64500,
})

async function rows<T>(query: string): Promise<T[]> {
  const rs = await ch.query({ query, format: 'JSONEachRow' })
  return rs.json<T>()
}

const partitions = async (): Promise<string[]> => {
  const r = await rows<{ partition_id: string }>(
    "SELECT DISTINCT partition_id FROM system.parts WHERE database = currentDatabase() AND table = 'clicks' AND active ORDER BY partition_id",
  )
  return r.map((p) => p.partition_id)
}

const addresses = async (): Promise<{ partition_id: string; ip: string }[]> =>
  rows('SELECT _partition_id AS partition_id, ip FROM clicks FINAL ORDER BY partition_id, click_id')

const rollupClicks = async (): Promise<number> => {
  const r = await rows<{ n: string }>('SELECT uniqExactMerge(clicks_state) AS n FROM clicks_hourly')
  return Number(r[0]?.n ?? 0)
}

/** Waits for every mutation on `clicks` to finish. Bounded, and never a sleep of hope. */
async function settleMutations(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await rows<{ n: string }>(
      "SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND table = 'clicks' AND NOT is_done",
    )
    if (Number(r[0]?.n ?? 0) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('a mutation on clicks never finished')
}

/**
 * Five months of clicks, one per month, each with a whole address. With a
 * 90-day raw period and a 30-day address period, run at 2026-09-24:
 *
 *   raw cutoff     2026-06-26  — a partition ending at or before this is dropped
 *   address cutoff 2026-08-25  — one ending at or before this is blanked
 *
 *   202605 ends 2026-06-01  dropped
 *   202606 ends 2026-07-01  kept, address blanked
 *   202607 ends 2026-08-01  kept, address blanked
 *   202608 ends 2026-09-01  kept, address kept
 *   202609 ends 2026-10-01  kept, address kept
 */
async function seed(): Promise<void> {
  await ch.command({ query: 'TRUNCATE TABLE clicks' })
  await ch.command({ query: 'TRUNCATE TABLE clicks_hourly' })
  await ch.command({ query: 'TRUNCATE TABLE clicks_hourly_dim' })
  await ch.insert({
    table: 'clicks',
    values: [
      click('01920000-0000-7000-8000-000000000005', '2026-05-15 10:00:00.000', '198.51.100.5'),
      click('01920000-0000-7000-8000-000000000006', '2026-06-15 10:00:00.000', '198.51.100.6'),
      click('01920000-0000-7000-8000-000000000007', '2026-07-15 10:00:00.000', '198.51.100.7'),
      click('01920000-0000-7000-8000-000000000008', '2026-08-15 10:00:00.000', '198.51.100.8'),
      click('01920000-0000-7000-8000-000000000009', '2026-09-15 10:00:00.000', '198.51.100.9'),
    ],
    format: 'JSONEachRow',
  })
}

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

beforeEach(async () => {
  await pool.query('TRUNCATE settings')
  await pool.query('INSERT INTO settings DEFAULT VALUES')
  await settleMutations()
  await seed()
})

afterAll(async () => {
  await pool.end()
  await operators.end()
  await ch.close()
})

describe('partitionEndMs', () => {
  it.each([
    ['202605', '2026-06-01T00:00:00.000Z'],
    ['202612', '2027-01-01T00:00:00.000Z'],
    ['202601', '2026-02-01T00:00:00.000Z'],
  ])('is the first instant after the month %s names', (id, iso) => {
    expect(partitionEndMs(id)).toBe(Date.parse(iso))
  })

  it.each([
    ['a partition that is not a month', '202613'],
    ['a month of zero', '202600'],
    ['a day partition', '20260524'],
    ['the whole table as one partition', 'all'],
    ['something with a quote in it', "2026'05"],
    ['an empty id', ''],
  ])('refuses %s', (_label, id) => {
    expect(partitionEndMs(id)).toBeNull()
  })
})

describe('runRetention', () => {
  it('drops a partition whose last possible row is past the period, and keeps the next one', async () => {
    const r = await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    expect(r.dropped).toEqual(['202605'])
    expect(await partitions()).toEqual(['202606', '202607', '202608', '202609'])
  })

  it('keeps every rollup number when it drops a partition', async () => {
    expect(await rollupClicks()).toBe(5)
    await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    expect(await rollupClicks()).toBe(5)
  })

  it('blanks the address in every partition past the address period and no others', async () => {
    const r = await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    expect(r.blanked).toEqual(['202606', '202607'])
    expect(await addresses()).toEqual([
      { partition_id: '202606', ip: '' },
      { partition_id: '202607', ip: '' },
      { partition_id: '202608', ip: '198.51.100.8' },
      { partition_id: '202609', ip: '198.51.100.9' },
    ])
  })

  it('does not blank a partition twice', async () => {
    await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    const second = await runRetention({ pg: pool, ch, now: NOW })
    expect(second.blanked).toEqual([])
    expect(second.dropped).toEqual([])
  })

  it('blanks nothing while a mutation is still running on the table', async () => {
    await ch.command({ query: 'SYSTEM STOP MERGES clicks' })
    try {
      await ch.command({
        query: "ALTER TABLE clicks UPDATE ip = '' IN PARTITION ID '202609' WHERE ip != ''",
      })
      const r = await runRetention({ pg: pool, ch, now: NOW })
      expect(r.mutationInFlight).toBe(true)
      expect(r.blanked).toEqual([])
      // And the drop still happened: a partition dropped whole is not a
      // mutation and is not waiting for one.
      expect(r.dropped).toEqual(['202605'])
    } finally {
      await ch.command({ query: 'SYSTEM START MERGES clicks' })
      await settleMutations()
    }
  })

  it('does nothing at all when the stored retention cannot be read', async () => {
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_raw_retention_valid')
    await pool.query('UPDATE settings SET raw_retention_days = -5')
    try {
      const r = await runRetention({ pg: pool, ch, now: NOW })
      expect(r).toEqual({
        dropped: [],
        blanked: [],
        skipped: [],
        mutationInFlight: false,
        ranNothing: true,
      })
      expect(await partitions()).toEqual(['202605', '202606', '202607', '202608', '202609'])
      expect(await addresses()).toHaveLength(5)
    } finally {
      // The row goes back inside the bound before the constraint does: a CHECK
      // added over a row that violates it is refused, and the failure would
      // arrive as this test's, in place of whatever it was actually asserting.
      await pool.query('UPDATE settings SET raw_retention_days = 90')
      await pool.query(
        'ALTER TABLE settings ADD CONSTRAINT settings_raw_retention_valid CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650)',
      )
    }
  })

  // The other half of the same rule, and the likelier half: a row deleted by
  // hand is one statement away, and the periods nobody chose are the ones a
  // default would supply. Separate from the test above because they arrive by
  // different paths — a row that fails the schema, and no row to read — and a
  // build that answered one with the defaults would still pass the other.
  it('does nothing at all when there is no settings row', async () => {
    await pool.query('TRUNCATE settings')
    const r = await runRetention({ pg: pool, ch, now: NOW })
    expect(r).toEqual({
      dropped: [],
      blanked: [],
      skipped: [],
      mutationInFlight: false,
      ranNothing: true,
    })
    expect(await partitions()).toEqual(['202605', '202606', '202607', '202608', '202609'])
    expect(await addresses()).toHaveLength(5)
  })

  it('deletes nothing when both periods are never', async () => {
    await pool.query('UPDATE settings SET raw_retention_days = NULL, ip_retention_days = NULL')
    const r = await runRetention({ pg: pool, ch, now: NOW })
    expect(r.dropped).toEqual([])
    expect(r.blanked).toEqual([])
    expect(await partitions()).toEqual(['202605', '202606', '202607', '202608', '202609'])
  })

  it('drops without blanking when only the raw period is set', async () => {
    await pool.query('UPDATE settings SET ip_retention_days = NULL')
    const r = await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    expect(r.dropped).toEqual(['202605'])
    expect(r.blanked).toEqual([])
    expect((await addresses()).every((a) => a.ip !== '')).toBe(true)
  })

  it('blanks without dropping when only the address period is set', async () => {
    await pool.query('UPDATE settings SET raw_retention_days = NULL')
    const r = await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    expect(r.dropped).toEqual([])
    // 202605 is past the address period too, and is still here to be blanked.
    expect(r.blanked).toEqual(['202605', '202606', '202607'])
    expect(await partitions()).toEqual(['202605', '202606', '202607', '202608', '202609'])
  })

  it('lowers a period and takes effect on the next pass, without rewriting history', async () => {
    await pool.query('UPDATE settings SET raw_retention_days = 30')
    const r = await runRetention({ pg: pool, ch, now: NOW })
    await settleMutations()
    // Cutoff 2026-08-25: every partition ending at or before it goes.
    expect(r.dropped).toEqual(['202605', '202606', '202607'])
    expect(await partitions()).toEqual(['202608', '202609'])
    expect(await rollupClicks()).toBe(5)
  })

  // A period read a moment before the delete is a period that can have been
  // changed by the time the delete runs, and nothing can put a Postgres read
  // and a ClickHouse drop in one transaction. The pass therefore reads under
  // the settings row's lock and holds it, which is what this pins: the pass is
  // made to wait on a lock an operator's own transaction holds, the operator
  // sets both periods to never inside it, and what the pass then acts on is
  // the row as committed — not the ninety days that were there when it
  // started.
  it('cannot enforce a period an operator changed while the pass was waiting for the row', async () => {
    const blocked = async (): Promise<boolean> => {
      const r = await operators.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()`,
      )
      return Number(r.rows[0]?.n ?? 0) > 0
    }
    const operator = await operators.connect()
    try {
      await operator.query('BEGIN')
      await operator.query('SELECT raw_retention_days FROM settings FOR UPDATE')
      const running = runRetention({ pg: pool, ch, now: NOW })
      let waiting = false
      for (let i = 0; i < 200 && !waiting; i++) {
        waiting = await blocked()
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      // Bounded, and asserted rather than assumed: a pass that never waits for
      // this lock has read the period without it, and the rest of this test
      // would be measuring a race instead of a guard.
      expect(waiting, 'the pass did not wait for the settings row').toBe(true)
      await operator.query(
        'UPDATE settings SET raw_retention_days = NULL, ip_retention_days = NULL',
      )
      await operator.query('COMMIT')
      const r = await running
      expect(r.dropped).toEqual([])
      expect(r.blanked).toEqual([])
      expect(await partitions()).toEqual(['202605', '202606', '202607', '202608', '202609'])
      expect((await addresses()).every((a) => a.ip !== '')).toBe(true)
    } finally {
      await operator.query('ROLLBACK').catch(() => {})
      operator.release()
    }
  })

  // The other end of holding that lock: a pass that throws while it holds it
  // must end its transaction before the client goes back to the pool. A client
  // released inside an open transaction takes the row lock with it, and the
  // next `settings set` an operator runs waits for a connection that is never
  // coming back — one failed pass, and the install cannot change its settings
  // until the worker restarts.
  it('holds no lock after a pass that threw', async () => {
    await expect(
      runRetention({
        pg: pool,
        ch,
        now: NOW,
        partitionSource: async () => {
          throw new Error('the partition list is unreadable')
        },
      }),
    ).rejects.toThrow('the partition list is unreadable')
    // From `operators`, never from `pool`: the pool hands the most recently
    // released client back first, so a question asked through it would be asked
    // *inside* the very transaction this is checking is over — and answered
    // yes. A separate pool is a separate backend, which is what an operator
    // running `settings set` is. This first cost the check its whole point: the
    // same assertion through `pool` passed with the rollback taken out.
    const operator = await operators.connect()
    try {
      await operator.query('BEGIN')
      // Bounded, so a lock nobody will release fails this test rather than
      // hanging it until the suite's own timeout.
      await operator.query("SET LOCAL lock_timeout = '5s'")
      await operator.query('SELECT 1 FROM settings FOR UPDATE')
      await operator.query('COMMIT')
    } finally {
      await operator.query('ROLLBACK').catch(() => {})
      operator.release()
    }
  })

  it('considers at most as many partitions as it is given, oldest first', async () => {
    const r = await runRetention({ pg: pool, ch, now: NOW, maxPartitions: 1 })
    await settleMutations()
    expect(r.dropped).toEqual(['202605'])
    expect(r.blanked).toEqual([])
  })

  it('logs and skips a partition id that is not a month rather than putting it in a statement', async () => {
    const said: string[] = []
    // A second table partitioned by something else cannot exist here, so the
    // skip is reached through the parser instead: the function that turns an
    // id into an instant is the gate, and it is tested above. What this pins is
    // that the pass asks it and acts on the answer.
    const r = await runRetention({
      pg: pool,
      ch,
      now: NOW,
      log: (m) => said.push(m),
      partitionSource: async () => ['202605', 'all', "2026'05"],
    })
    await settleMutations()
    expect(r.dropped).toEqual(['202605'])
    expect(r.skipped).toEqual(['all', "2026'05"])
    expect(said.join(' ')).toContain('not a month')
    // The table is still there: nothing was interpolated.
    expect(await partitions()).toEqual(['202606', '202607', '202608', '202609'])
  })
})

describe('startRetention', () => {
  it('runs a pass and stops when it is told to', async () => {
    const passes: string[] = []
    const loop = startRetention({
      pg: pool,
      ch,
      intervalMs: 50,
      now: () => NOW,
      log: (m) => passes.push(m),
    })
    try {
      for (let i = 0; i < 100 && passes.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(passes.length).toBeGreaterThan(0)
    } finally {
      await loop.stop()
    }
    await settleMutations()
    const after = passes.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(passes.length).toBe(after)
  })

  // `stop()` waits for the pass in flight, and the interval in production is an
  // hour. So a loop told to stop *during* a pass must not go on to set the next
  // hour's timer: nothing wakes a timer set after the stop, and `stop()` would
  // then be a shutdown that hangs until the interval runs out — which SIGTERM
  // does not wait for, so the container is killed instead of stopping.
  it('stops without waiting out the interval when it is told to during a pass', async () => {
    const loop = startRetention({ pg: pool, ch, intervalMs: 3_600_000, now: () => NOW })
    // The next statement after starting it, so the first pass — several round
    // trips to two stores — is certainly still running.
    const began = Date.now()
    await loop.stop()
    expect(Date.now() - began).toBeLessThan(10_000)
    await settleMutations()
  })
})
