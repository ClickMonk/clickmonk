import { newVerificationToken, verificationRecordValue } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type DomainResolver,
  MAX_DETAIL,
  checkDomain,
  runDomainChecks,
  startDomainChecker,
} from './domains.js'

const pool = testPg()
const ch = testCh()

beforeAll(async () => {
  await resetDatabases(pool, ch)
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

/** A resolver that answers from a table. Nothing here touches DNS. */
function fakeResolver(answers: {
  txt?: Record<string, string[][] | { code: string }>
  a?: Record<string, string[]>
  aaaa?: Record<string, string[]>
}): DomainResolver & { cancelled: number } {
  const fail = (code: string) => Object.assign(new Error(`queryTxt ${code}`), { code })
  const r = {
    cancelled: 0,
    async resolveTxt(name: string) {
      const a = answers.txt?.[name]
      if (a === undefined) throw fail('ENOTFOUND')
      if (!Array.isArray(a)) throw fail(a.code)
      return a
    },
    async resolve4(host: string) {
      const a = answers.a?.[host]
      if (a === undefined) throw fail('ENODATA')
      return a
    },
    async resolve6(host: string) {
      const a = answers.aaaa?.[host]
      if (a === undefined) throw fail('ENODATA')
      return a
    },
    cancel() {
      r.cancelled++
    },
  }
  return r
}

const TOKEN = 'c'.repeat(32)
const NAME = '_clickmonk.go.example.test'

describe('checkDomain', () => {
  it('verifies a host whose TXT record carries the token, and reports what it resolves to', async () => {
    const r = await checkDomain(
      fakeResolver({
        txt: { [NAME]: [[verificationRecordValue(TOKEN)]] },
        a: { 'go.example.test': ['192.0.2.10'] },
        aaaa: { 'go.example.test': ['2001:db8::10'] },
      }),
      'go.example.test',
      TOKEN,
    )
    expect(r.status).toBe('verified')
    expect(r.detail).toContain('192.0.2.10')
    expect(r.detail).toContain('2001:db8::10')
  })

  it('verifies a host with the token and no address at all, and says so', async () => {
    const r = await checkDomain(
      fakeResolver({ txt: { [NAME]: [[verificationRecordValue(TOKEN)]] } }),
      'go.example.test',
      TOKEN,
    )
    expect(r.status).toBe('verified')
    expect(r.detail).toContain('no A or AAAA record')
  })

  it('reports a missing name and a name without the token as missing, not as an error', async () => {
    const absent = await checkDomain(fakeResolver({}), 'go.example.test', TOKEN)
    expect(absent).toEqual({ status: 'missing_token', detail: `no TXT record at ${NAME}` })
    const other = await checkDomain(
      fakeResolver({ txt: { [NAME]: [['v=spf1 -all']] } }),
      'go.example.test',
      TOKEN,
    )
    expect(other.status).toBe('missing_token')
    expect(other.detail).toContain('1 TXT record(s)')
  })

  it('reports a resolver that could not answer as an error, never as a missing token', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'ECANCELLED']) {
      const r = await checkDomain(
        fakeResolver({ txt: { [NAME]: { code } } }),
        'go.example.test',
        TOKEN,
      )
      expect(r, code).toMatchObject({ status: 'error' })
      expect(r.detail).toContain(code)
    }
  })

  it('cuts a detail that would not fit the column', async () => {
    const many = Array.from({ length: 400 }, (_, i) => `192.0.2.${i % 256}`)
    const r = await checkDomain(
      fakeResolver({
        txt: { [NAME]: [[verificationRecordValue(TOKEN)]] },
        a: { 'go.example.test': many },
      }),
      'go.example.test',
      TOKEN,
    )
    expect(r.status).toBe('verified')
    expect(r.detail.length).toBeLessThanOrEqual(MAX_DETAIL)
  })
})

async function addDomain(host: string, verified = false): Promise<{ id: string; token: string }> {
  const token = newVerificationToken()
  const r = await pool.query<{ id: string }>(
    'INSERT INTO domains (host, verified, verification_token) VALUES ($1, $2, $3) RETURNING id',
    [host, verified, token],
  )
  return { id: r.rows[0]?.id as string, token }
}

const checkOf = (id: string) =>
  pool
    .query<{ status: string; detail: string; checked_at: Date }>(
      'SELECT status, detail, checked_at FROM domain_dns_checks WHERE domain_id = $1',
      [id],
    )
    .then((r) => r.rows[0])

const verifiedOf = (id: string) =>
  pool
    .query<{ verified: boolean }>('SELECT verified FROM domains WHERE id = $1', [id])
    .then((r) => r.rows[0]?.verified)

describe('runDomainChecks', () => {
  afterEach(async () => {
    await pool.query('TRUNCATE domains CASCADE')
  })

  it('verifies a domain that publishes its own token, and records the check', async () => {
    const d = await addDomain('go.example.test')
    const run = await runDomainChecks({
      pg: pool,
      resolver: fakeResolver({ txt: { [NAME]: [[verificationRecordValue(d.token)]] } }),
    })
    expect(run).toEqual({ checked: 1, verified: 1, failed: 0 })
    expect(await verifiedOf(d.id)).toBe(true)
    expect((await checkOf(d.id))?.status).toBe('verified')
  })

  it('refuses a domain publishing another domain’s token', async () => {
    const mine = await addDomain('go.example.test')
    const theirs = await addDomain('other.example.test')
    const run = await runDomainChecks({
      pg: pool,
      resolver: fakeResolver({ txt: { [NAME]: [[verificationRecordValue(theirs.token)]] } }),
    })
    expect(run).toMatchObject({ verified: 0, failed: 2 })
    expect(await verifiedOf(mine.id)).toBe(false)
  })

  it('never un-verifies a domain whose record has gone, and records why', async () => {
    const d = await addDomain('go.example.test', true)
    await runDomainChecks({ pg: pool, resolver: fakeResolver({}) })
    expect(await verifiedOf(d.id)).toBe(true)
    expect((await checkOf(d.id))?.status).toBe('missing_token')
  })

  it('takes the least recently checked first, so every domain comes round', async () => {
    const a = await addDomain('a.example.test')
    const b = await addDomain('b.example.test')
    const now = new Date()
    const resolver = fakeResolver({})
    await runDomainChecks({ pg: pool, resolver, limit: 1, now: () => now })
    expect(await checkOf(a.id)).toBeDefined()
    expect(await checkOf(b.id)).toBeUndefined()
    await runDomainChecks({ pg: pool, resolver, limit: 1, now: () => new Date(now.getTime() + 1) })
    expect(await checkOf(b.id)).toBeDefined()
  })

  it('notifies the redirect only when a domain actually becomes verified', async () => {
    const d = await addDomain('go.example.test')
    // A pooled connection, not a second client: the worker package has no pg
    // dependency of its own, and this one is destroyed rather than returned.
    const listener = await pool.connect()
    let notifications = 0
    listener.on('notification', () => {
      notifications++
    })
    await listener.query('LISTEN config_changed')
    try {
      const resolver = fakeResolver({ txt: { [NAME]: [[verificationRecordValue(d.token)]] } })
      await runDomainChecks({ pg: pool, resolver })
      await listener.query('SELECT 1')
      expect(notifications).toBe(1)
      // The second pass changes nothing, so the redirect is left alone.
      await runDomainChecks({ pg: pool, resolver })
      await listener.query('SELECT 1')
      expect(notifications).toBe(1)
    } finally {
      listener.release(true)
    }
  })
})

describe('startDomainChecker', () => {
  // Every checker this block starts is registered here and stopped in
  // afterEach as well as in the test. Both tests below can throw on their
  // deadline before reaching their own stop(), and a loop that outlives the
  // test goes on querying a pool that afterAll has ended. stop() is
  // idempotent and bounded, so stopping an already-stopped checker costs
  // nothing.
  let running: { stop(): Promise<void> } | null = null

  afterEach(async () => {
    await running?.stop()
    running = null
    await pool.query('TRUNCATE domains CASCADE')
  })

  it('runs a pass at once and stops without waiting for the interval', async () => {
    const d = await addDomain('go.example.test')
    const resolver = fakeResolver({ txt: { [NAME]: [[verificationRecordValue(d.token)]] } })
    const checker = startDomainChecker({ pg: pool, resolver, intervalMs: 3_600_000 })
    running = checker
    const deadline = Date.now() + 10_000
    while ((await verifiedOf(d.id)) !== true) {
      if (Date.now() > deadline) throw new Error('the first pass never ran')
      await new Promise((r) => setTimeout(r, 20))
    }
    const started = Date.now()
    await checker.stop()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(resolver.cancelled).toBeGreaterThan(0)
  })

  it('keeps running when a pass throws', async () => {
    const broken = {
      query: () => Promise.reject(new Error('postgres is down')),
    } as unknown as Pool
    const logged: string[] = []
    const checker = startDomainChecker({
      pg: broken,
      resolver: fakeResolver({}),
      intervalMs: 10,
      log: (m) => logged.push(m),
    })
    running = checker
    const deadline = Date.now() + 5_000
    while (logged.filter((l) => l.includes('domain check failed')).length < 2) {
      if (Date.now() > deadline) throw new Error('the loop stopped after one failure')
      await new Promise((r) => setTimeout(r, 20))
    }
    await checker.stop()
  })
})
