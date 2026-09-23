import { ConcurrencyGate, hashToken, newApiKey, verificationRecordValue } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { DomainResolver } from '@clickmonk/worker/domains'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_DOMAINS_LISTED, MIN_CHECK_INTERVAL_MS } from './domains.js'
import { ADMIN_HOST, clockFrom, read, signedIn, testApp, write } from './testing.js'

const pg = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-23T10:00:00.000Z'))
let app: FastifyInstance
let cookie = ''

/** A resolver the test drives: what DNS says, and nothing on the network. */
class FakeResolver implements DomainResolver {
  txt: string[][] = []
  txtError: NodeJS.ErrnoException | null = null
  cancelled = 0
  /** How many times DNS was actually asked: what the interval bound must stop. */
  asked = 0

  async resolveTxt(): Promise<string[][]> {
    this.asked++
    if (this.txtError) throw this.txtError
    return this.txt
  }
  async resolve4(): Promise<string[]> {
    return ['192.0.2.10']
  }
  async resolve6(): Promise<string[]> {
    const err: NodeJS.ErrnoException = new Error('no AAAA')
    err.code = 'ENODATA'
    throw err
  }
  cancel(): void {
    this.cancelled++
  }
}

let resolver = new FakeResolver()

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

beforeEach(async () => {
  clock.set(new Date('2026-09-23T10:00:00.000Z'))
  await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  await pg.query('TRUNCATE domains CASCADE')
  resolver = new FakeResolver()
  app = testApp(pg, clock, { resolver: () => resolver })
  cookie = await signedIn(app, pg)
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

const add = (payload: Record<string, unknown> = { host: 'go.example.test' }) =>
  app.inject({ method: 'POST', url: '/api/domains', headers: write(cookie), payload })

describe('adding a domain', () => {
  // The flag that gates serving and certificate issuance is not something the
  // network can set. A DNS check that finds this install's token, or
  // `domain add --verified` typed on the server, are the only two ways.
  it('is unverified, with a token this install minted, and prints the record', async () => {
    const r = await add()
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body.verified).toBe(false)
    expect(body.verificationRecord.name).toBe('_clickmonk.go.example.test')
    const stored = await pg.query<{ verification_token: string; verified: boolean }>(
      'SELECT verification_token, verified FROM domains',
    )
    expect(stored.rows[0]?.verified).toBe(false)
    expect(stored.rows[0]?.verification_token).toMatch(/^[0-9a-f]{32}$/)
    expect(body.verificationRecord.value).toBe(
      verificationRecordValue(stored.rows[0]?.verification_token as string),
    )
  })

  it('refuses a body that tries to mark it verified', async () => {
    expect((await add({ host: 'go.example.test', verified: true })).statusCode).toBe(400)
    expect((await pg.query('SELECT 1 FROM domains')).rowCount).toBe(0)
  })

  // The half of the bearer exemption that needs a key-writable endpoint: a key
  // writes with no `Origin` at all, because a browser cannot attach an
  // `Authorization` header cross-site without a preflight this service answers
  // nothing to.
  it('is written by an API key with no Origin header', async () => {
    const key = newApiKey()
    await pg.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
      key.id,
      'scripting',
      hashToken(key.secret),
    ])
    const r = await app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { host: ADMIN_HOST, authorization: `Bearer ${key.display}` },
      payload: { host: 'go.example.test' },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().verified).toBe(false)
    // And the same request with a cookie and no Origin is still refused, so the
    // exemption is the key's and not a hole in the check.
    const viaCookie = await app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { host: ADMIN_HOST, cookie },
      payload: { host: 'two.example.test' },
    })
    expect(viaCookie.statusCode).toBe(403)
    expect(viaCookie.json().error).toBe('bad_origin')
  })

  it('says when the listing was cut', async () => {
    const list = () => app.inject({ method: 'GET', url: '/api/domains', headers: read(cookie) })
    await add()
    expect((await list()).json().truncated).toBe(false)
    await pg.query(
      `INSERT INTO domains (host, verification_token)
       SELECT 'bulk-' || n || '.example.test', lpad(to_hex(n), 32, '0')
         FROM generate_series(1, $1) AS n`,
      [MAX_DOMAINS_LISTED],
    )
    const cut = await list()
    expect(cut.json().domains).toHaveLength(MAX_DOMAINS_LISTED)
    expect(cut.json().truncated).toBe(true)
  })

  it('normalises the host name and refuses one that is not a host name', async () => {
    const r = await add({ host: 'GO.Example.Test.' })
    expect(r.json().host).toBe('go.example.test')
    for (const host of ['', 'not a host', 'go.example.test:443', 'https://go.example.test']) {
      const bad = await add({ host })
      expect([400], host).toContain(bad.statusCode)
    }
  })

  it('refuses a second domain with the same host', async () => {
    expect((await add()).statusCode).toBe(201)
    const again = await add()
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('host_taken')
  })

  it('takes a root and a not-found URL, and refuses one carrying a token', async () => {
    const r = await add({
      host: 'go.example.test',
      rootUrl: 'https://example.com/',
      notFoundUrl: 'https://example.com/gone',
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().rootUrl).toBe('https://example.com/')
    const bad = await add({ host: 'two.example.test', rootUrl: 'https://example.com/{click_id}' })
    expect(bad.statusCode).toBe(400)
  })
})

describe('changing and removing one', () => {
  it('changes only the fields given', async () => {
    const created = (await add({ host: 'go.example.test', rootUrl: 'https://example.com/' })).json()
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/domains/${created.id}`,
      headers: write(cookie),
      payload: { notFoundUrl: 'https://example.com/gone' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().rootUrl).toBe('https://example.com/')
    expect(patched.json().notFoundUrl).toBe('https://example.com/gone')
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/domains/${created.id}`,
      headers: write(cookie),
      payload: { rootUrl: null },
    })
    expect(cleared.json().rootUrl).toBeNull()
  })

  it('takes its links with it', async () => {
    const created = (await add()).json()
    await pg.query("INSERT INTO links (domain_id, slug) VALUES ($1, 'x')", [created.id])
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/domains/${created.id}`,
      headers: write(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect((await pg.query('SELECT 1 FROM links')).rowCount).toBe(0)
  })

  it('answers 404 for an id that is not one, without touching anything', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const r = await app.inject({
        method: 'DELETE',
        url: `/api/domains/${id}`,
        headers: write(cookie),
      })
      expect(r.statusCode, id).toBe(404)
    }
  })

  // A 404 here would tell the caller the id was wrong when the body was, and
  // they would go looking in the wrong place.
  it('answers 400 for a body it cannot read, before it looks the domain up', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/domains/00000000-0000-4000-8000-00000000dead',
      headers: write(cookie),
      payload: { verified: true },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
  })
})

describe('checking the DNS on demand', () => {
  it('verifies the domain when the token is published, through the one writer', async () => {
    const created = (await add()).json()
    const token = (
      await pg.query<{ verification_token: string }>('SELECT verification_token FROM domains')
    ).rows[0]?.verification_token as string
    resolver.txt = [[verificationRecordValue(token)]]
    const r = await app.inject({
      method: 'POST',
      url: `/api/domains/${created.id}/check`,
      headers: write(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().status).toBe('verified')
    const row = await pg.query<{ verified: boolean }>('SELECT verified FROM domains')
    expect(row.rows[0]?.verified).toBe(true)
    // Recorded where the worker and the CLI record it, with the same clock.
    const check = await pg.query<{ status: string; checked_at: Date }>(
      'SELECT status, checked_at FROM domain_dns_checks',
    )
    expect(check.rows[0]?.status).toBe('verified')
    expect(check.rows[0]?.checked_at.toISOString()).toBe(clock.now().toISOString())
    expect(resolver.cancelled).toBe(1)
  })

  it('leaves a domain unverified when the token is not there, and says why', async () => {
    const created = (await add()).json()
    resolver.txt = [['v=spf1 -all']]
    const r = await app.inject({
      method: 'POST',
      url: `/api/domains/${created.id}/check`,
      headers: write(cookie),
    })
    expect(r.json().status).toBe('missing_token')
    expect(
      (await pg.query<{ verified: boolean }>('SELECT verified FROM domains')).rows[0]?.verified,
    ).toBe(false)
  })

  // A credential is not a bound. Without this an authenticated caller loops
  // the endpoint and every pass is a DNS query through the install's own
  // resolvers, for a host name the caller chose, plus a write.
  it('refuses a second check inside the interval, and answers what it already knows', async () => {
    const created = (await add()).json()
    const check = () =>
      app.inject({
        method: 'POST',
        url: `/api/domains/${created.id}/check`,
        headers: write(cookie),
      })
    resolver.txt = [['nothing useful']]
    expect((await check()).statusCode).toBe(200)
    expect(resolver.asked).toBe(1)

    const refused = await check()
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error).toBe('checked_recently')
    // The stored result comes back with the refusal, and DNS was not asked.
    expect(refused.json().message).toContain('missing_token')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect(resolver.asked).toBe(1)

    // And the interval passing lets it through again.
    clock.advance(MIN_CHECK_INTERVAL_MS + 1000)
    expect((await check()).statusCode).toBe(200)
    expect(resolver.asked).toBe(2)
  })

  it('refuses a check when too many are already in flight', async () => {
    const created = (await add()).json()
    // A second app on the same database, so the session this test already has
    // works on it; only the gate differs. The account is `beforeEach`'s.
    const full = testApp(pg, clock, {
      resolver: () => resolver,
      checkGate: new ConcurrencyGate(0),
    })
    try {
      const r = await full.inject({
        method: 'POST',
        url: `/api/domains/${created.id}/check`,
        headers: write(cookie),
      })
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_checks')
      expect(r.headers['retry-after']).toBe('1')
      // Failing closed: no query, and no row written.
      expect(resolver.asked).toBe(0)
      expect((await pg.query('SELECT 1 FROM domain_dns_checks')).rowCount).toBe(0)
    } finally {
      await full.close()
    }
  })

  it('never un-verifies a domain whose check fails', async () => {
    const created = (await add()).json()
    await pg.query('UPDATE domains SET verified = true')
    const err: NodeJS.ErrnoException = new Error('servfail')
    err.code = 'ESERVFAIL'
    resolver.txtError = err
    const r = await app.inject({
      method: 'POST',
      url: `/api/domains/${created.id}/check`,
      headers: write(cookie),
    })
    expect(r.json().status).toBe('error')
    expect(
      (await pg.query<{ verified: boolean }>('SELECT verified FROM domains')).rows[0]?.verified,
    ).toBe(true)
  })
})

describe('taking a domain off the air', () => {
  it('un-verifies it, and says the certificate outlives it', async () => {
    const created = (await add()).json()
    await pg.query('UPDATE domains SET verified = true')
    const r = await app.inject({
      method: 'POST',
      url: `/api/domains/${created.id}/unverify`,
      headers: write(cookie),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().note).toContain('presented until it expires')
    expect(
      (await pg.query<{ verified: boolean }>('SELECT verified FROM domains')).rows[0]?.verified,
    ).toBe(false)
  })
})

describe('what the operator has to know', () => {
  it('lists a domain no check has reached, and one whose check failed', async () => {
    const never = (await add({ host: 'never.example.test' })).json()
    const failing = (await add({ host: 'failing.example.test' })).json()
    const good = (await add({ host: 'good.example.test' })).json()
    const token = (
      await pg.query<{ verification_token: string }>(
        'SELECT verification_token FROM domains WHERE id = $1',
        [good.id],
      )
    ).rows[0]?.verification_token as string
    resolver.txt = [[verificationRecordValue(token)]]
    await app.inject({
      method: 'POST',
      url: `/api/domains/${good.id}/check`,
      headers: write(cookie),
    })
    resolver.txt = [['nothing useful']]
    await app.inject({
      method: 'POST',
      url: `/api/domains/${failing.id}/check`,
      headers: write(cookie),
    })

    const r = await app.inject({ method: 'GET', url: '/api/alerts', headers: read(cookie) })
    expect(r.statusCode).toBe(200)
    const hosts = (r.json().domains as { host: string; status: string }[]).map(
      (d) => `${d.host}:${d.status}`,
    )
    expect(hosts).toContain(`${never.host}:never_checked`)
    expect(hosts).toContain(`${failing.host}:missing_token`)
    expect(hosts.some((h) => h.startsWith(good.host))).toBe(false)
  })
})
