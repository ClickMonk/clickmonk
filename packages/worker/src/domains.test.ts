import { newVerificationToken, verificationRecordValue } from '@clickmonk/core'
import type { Pool } from '@clickmonk/db'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type DomainResolver,
  MAX_ADDRESSES,
  MAX_DETAIL,
  checkDomain,
  isResolverAddress,
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

  it('says the address could not be looked up, when the resolver could not answer, never that there is none', async () => {
    const resolver: DomainResolver = {
      async resolveTxt() {
        return [[verificationRecordValue(TOKEN)]]
      },
      async resolve4() {
        throw Object.assign(new Error('a lookup failed'), { code: 'ESERVFAIL' })
      },
      async resolve6() {
        throw Object.assign(new Error('aaaa lookup failed'), { code: 'ESERVFAIL' })
      },
      cancel() {},
    }
    const r = await checkDomain(resolver, 'go.example.test', TOKEN)
    expect(r.status).toBe('verified')
    expect(r.detail).toContain('could not be looked up')
    expect(r.detail).toContain('ESERVFAIL')
    expect(r.detail).not.toContain('no A or AAAA record')
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

  it('names at most MAX_ADDRESSES addresses and says how many more, whatever the resolver returns', async () => {
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
    for (const addr of many.slice(0, MAX_ADDRESSES)) expect(r.detail).toContain(addr)
    // The first address past the shown ones, whatever MAX_ADDRESSES is —
    // derived from it rather than written out, so the two halves of this
    // test cannot quietly disagree if the bound ever changes. It does not
    // recur until the list wraps past index 256 — well beyond what any
    // correct implementation writes.
    const firstOmitted = many[MAX_ADDRESSES]
    if (!firstOmitted) throw new Error('fixture too short for MAX_ADDRESSES')
    expect(r.detail).not.toContain(firstOmitted)
    expect(r.detail).toContain(`and ${many.length - MAX_ADDRESSES} more`)
    expect(r.detail.length).toBeLessThanOrEqual(MAX_DETAIL)
  })

  it('cuts an error detail too, when the overflow comes from the resolver’s own message', async () => {
    // The address list is bounded by MAX_ADDRESSES before it ever reaches
    // MAX_DETAIL, so the previous test never actually needs cut() to act.
    // A resolver's own error message has no such bound: it is text this
    // install did not choose, from a library or an OS resolver, and nothing
    // here caps its length before it is written into the detail.
    const resolver: DomainResolver = {
      async resolveTxt() {
        throw new Error('x'.repeat(600))
      },
      async resolve4() {
        throw new Error('unused')
      },
      async resolve6() {
        throw new Error('unused')
      },
      cancel() {},
    }
    const r = await checkDomain(resolver, 'go.example.test', TOKEN)
    expect(r.status).toBe('error')
    expect(r.detail.length).toBeLessThanOrEqual(MAX_DETAIL)
  })
})

describe('isResolverAddress', () => {
  it('accepts a bare address, IPv4 or IPv6', () => {
    expect(isResolverAddress('192.0.2.1')).toBe(true)
    expect(isResolverAddress('2001:db8::1')).toBe(true)
  })

  it('accepts an address with a port', () => {
    expect(isResolverAddress('192.0.2.1:5353')).toBe(true)
    expect(isResolverAddress('[2001:db8::1]:5353')).toBe(true)
  })

  it('refuses port 0: not a usable destination port', () => {
    expect(isResolverAddress('192.0.2.1:0')).toBe(false)
    expect(isResolverAddress('[2001:db8::1]:0')).toBe(false)
  })

  it('refuses a port past 65535', () => {
    expect(isResolverAddress('192.0.2.1:70000')).toBe(false)
    expect(isResolverAddress('[2001:db8::1]:70000')).toBe(false)
  })

  it('refuses anything that is not an address', () => {
    expect(isResolverAddress('resolver.example.test')).toBe(false)
    expect(isResolverAddress('')).toBe(false)
    expect(isResolverAddress('192.0.2.1:')).toBe(false)
  })
})

async function addDomain(
  host: string,
  verified = false,
  token: string = newVerificationToken(),
): Promise<{ id: string; token: string }> {
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
    // go.example.test really does own TOKEN, so it verifies normally. The
    // attack is other.example.test publishing that same TOKEN at ITS OWN
    // name: one well-formed record, a real address behind it, wrong only in
    // whose token it is. Both domains resolving correctly except for that
    // is what makes this pin the token comparison itself: a check that
    // compared every row against a fixed known token instead of its own
    // would verify both instead of just the true owner.
    const owner = await addDomain('go.example.test', false, TOKEN)
    const impostor = await addDomain('other.example.test')
    const run = await runDomainChecks({
      pg: pool,
      resolver: fakeResolver({
        txt: {
          [NAME]: [[verificationRecordValue(TOKEN)]],
          '_clickmonk.other.example.test': [[verificationRecordValue(TOKEN)]],
        },
        a: { 'other.example.test': ['192.0.2.20'] },
      }),
    })
    expect(run).toEqual({ checked: 2, verified: 1, failed: 1 })
    expect(await verifiedOf(owner.id)).toBe(true)
    expect(await verifiedOf(impostor.id)).toBe(false)
    expect((await checkOf(impostor.id))?.status).toBe('missing_token')
  })

  it('never un-verifies a domain whose record has gone, and records why', async () => {
    const d = await addDomain('go.example.test', true)
    await runDomainChecks({ pg: pool, resolver: fakeResolver({}) })
    expect(await verifiedOf(d.id)).toBe(true)
    expect((await checkOf(d.id))?.status).toBe('missing_token')
  })

  it('records nothing for a check whose signal was aborted mid-flight, and leaves what was there alone', async () => {
    // a has no prior row (sorts first, NULLS FIRST) and checks cleanly. b
    // already has a good row from an earlier pass; the abort lands while
    // b's own lookup is still in flight, simulating a shutdown that catches
    // a check mid-air rather than between domains.
    const a = await addDomain('a.example.test')
    const b = await addDomain('b.example.test', true)
    const before = new Date(Date.now() - 60_000)
    await pool.query(
      "INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at) VALUES ($1, 'verified', 'previously fine', $2)",
      [b.id, before],
    )
    const abort = new AbortController()
    const base = fakeResolver({
      txt: { '_clickmonk.a.example.test': [[verificationRecordValue(a.token)]] },
    })
    const resolver: DomainResolver = {
      resolveTxt: async (name) => {
        if (name === '_clickmonk.b.example.test') abort.abort()
        return base.resolveTxt(name)
      },
      resolve4: (h) => base.resolve4(h),
      resolve6: (h) => base.resolve6(h),
      cancel: () => base.cancel(),
    }
    const run = await runDomainChecks({ pg: pool, resolver, signal: abort.signal })
    expect(run).toEqual({ checked: 1, verified: 1, failed: 0 })
    expect((await checkOf(a.id))?.status).toBe('verified')
    const bCheck = await checkOf(b.id)
    expect(bCheck?.status).toBe('verified')
    expect(bCheck?.detail).toBe('previously fine')
    expect(bCheck?.checked_at.getTime()).toBe(before.getTime())
    expect(await verifiedOf(b.id)).toBe(true)
  })

  it('never queries the resolver once the signal is already aborted', async () => {
    await addDomain('a.example.test')
    const abort = new AbortController()
    abort.abort()
    let queried = false
    const resolver: DomainResolver = {
      resolveTxt: async () => {
        queried = true
        throw new Error('should not have been called')
      },
      resolve4: async () => {
        queried = true
        throw new Error('should not have been called')
      },
      resolve6: async () => {
        queried = true
        throw new Error('should not have been called')
      },
      cancel() {},
    }
    const run = await runDomainChecks({ pg: pool, resolver, signal: abort.signal })
    expect(run).toEqual({ checked: 0, verified: 0, failed: 0 })
    expect(queried).toBe(false)
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
    // Both domains now have a row: a's is the older one (now < now+1), so a
    // third pass must pick a again — rotation past the first round, not
    // just past the initial NULLS-FIRST ordering — and its checked_at must
    // actually advance, or a would look "due" forever and b would never be
    // revisited.
    const third = new Date(now.getTime() + 2)
    await runDomainChecks({ pg: pool, resolver, limit: 1, now: () => third })
    expect((await checkOf(a.id))?.checked_at.getTime()).toBe(third.getTime())
    expect((await checkOf(b.id))?.checked_at.getTime()).toBe(now.getTime() + 1)
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

  it('logs a transition once, not every pass it stays the same', async () => {
    await addDomain('go.example.test')
    const resolver = fakeResolver({}) // no TXT answer at all: stays missing_token every pass
    let logged: string[] = []
    const log = (m: string) => logged.push(m)

    await runDomainChecks({ pg: pool, resolver, log })
    // The very first check is a transition (never checked before).
    expect(logged.filter((l) => l.includes('go.example.test'))).toHaveLength(1)

    logged = []
    await runDomainChecks({ pg: pool, resolver, log })
    // Still missing_token, unchanged from last pass: no per-domain line —
    // an outage or a removed record must not write one of these every pass
    // for as long as it lasts.
    expect(logged.filter((l) => l.includes('go.example.test'))).toHaveLength(0)
  })

  it('logs exactly one pass summary line, however many domains it checked', async () => {
    // Two domains: a summary written once per domain, instead of once per
    // pass, would produce two lines here and one would never tell.
    await addDomain('a.example.test')
    await addDomain('b.example.test')
    const resolver = fakeResolver({})
    const logged: string[] = []
    await runDomainChecks({ pg: pool, resolver, log: (m) => logged.push(m) })
    expect(logged.filter((l) => l.startsWith('domain check:'))).toHaveLength(1)
  })

  it('with logEvery, logs every domain checked, whatever its transition — for a command someone just ran', async () => {
    await addDomain('go.example.test')
    const resolver = fakeResolver({}) // stays missing_token every pass, same as the transition-only case above
    let logged: string[] = []
    const log = (m: string) => logged.push(m)

    await runDomainChecks({ pg: pool, resolver, log, logEvery: true })
    expect(logged.filter((l) => l.includes('go.example.test'))).toHaveLength(1)

    logged = []
    await runDomainChecks({ pg: pool, resolver, log, logEvery: true })
    // Unchanged from last pass, but logEvery asked for this domain's line
    // regardless — an operator who just typed a command wants to see the
    // domain they asked about, not only a transition.
    expect(logged.filter((l) => l.includes('go.example.test'))).toHaveLength(1)
    // Still exactly one summary line, same as the default.
    expect(logged.filter((l) => l.startsWith('domain check:'))).toHaveLength(1)
  })

  it('accepts a detail of exactly MAX_DETAIL; the migration’s column refuses one byte more', async () => {
    // Nothing ties the MAX_DETAIL constant to the column's own CHECK
    // constraint but this: if either moves without the other, one half of
    // this test fails.
    const ok = await addDomain('ok.example.test')
    const long = await addDomain('long.example.test')
    await pool.query(
      "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'verified', $2)",
      [ok.id, 'x'.repeat(MAX_DETAIL)],
    )
    expect((await checkOf(ok.id))?.detail.length).toBe(MAX_DETAIL)
    await expect(
      pool.query(
        "INSERT INTO domain_dns_checks (domain_id, status, detail) VALUES ($1, 'verified', $2)",
        [long.id, 'x'.repeat(MAX_DETAIL + 1)],
      ),
    ).rejects.toThrow()
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
