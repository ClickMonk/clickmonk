import { ConcurrencyGate, hashToken, newApiKey, verificationRecordValue } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { DomainResolver } from '@clickmonk/worker/domains'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CHECKS_IN_FLIGHT, MAX_DOMAINS_LISTED, MIN_CHECK_INTERVAL_MS } from './domains.js'
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
  /**
   * A lookup waits on this before answering, so a test can hold queries open
   * and have a known number of checks in flight at once. Ordering only: no
   * timer, and no wall clock.
   */
  held: Promise<void> | null = null
  /** Called as each lookup starts, so a test can wait for the nth one. */
  onAsked: (() => void) | null = null

  async resolveTxt(): Promise<string[][]> {
    this.asked++
    this.onAsked?.()
    if (this.held) await this.held
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

/** A promise and the handle that settles it, for ordering without timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = () => {
      r()
    }
  })
  return { promise, resolve }
}

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

beforeEach(async () => {
  clock.set(new Date('2026-09-23T10:00:00.000Z'))
  await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  await pg.query('TRUNCATE domains CASCADE')
  resolver = new FakeResolver()
  app = testApp(pg, clock, { resolver: () => resolver })
  cookie = await signedIn(app, pg, clock.now())
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

// The host guard and the cross-site check are not credentials: `curl` sets
// any `Origin` it likes, and a bearer-shaped header skips that check
// altogether. The hook resolves whatever credential a request carries and
// refuses nothing, so the call in each handler is the whole of what stands
// between a stranger and this API. One row per route, so removing one
// handler's call fails that row alone.
describe('every route needs a credential', () => {
  const rowCount = async (sql: string, params: unknown[]) => (await pg.query(sql, params)).rowCount

  /**
   * One row per route: the refusal, and the state that route would have
   * changed, read back afterwards. The status code alone is not the guard —
   * a handler that acts and *then* refuses answers 401 having already
   * deleted the domain — so each write row names what must still be true.
   *
   * The three reads change nothing, so what they must not do is answer with
   * the data; that is pinned for every row by the body carrying the refusal
   * and nothing else.
   */
  interface Anonymous {
    name: string
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    path: string
    payload?: Record<string, unknown>
    unchanged?: (id: string) => Promise<void>
  }

  const anonymous: Anonymous[] = [
    { name: 'GET /api/domains', method: 'GET', path: '/api/domains' },
    {
      name: 'POST /api/domains',
      method: 'POST',
      path: '/api/domains',
      payload: { host: 'anon.example.test' },
      unchanged: async () => {
        expect(await rowCount('SELECT 1 FROM domains WHERE host = $1', ['anon.example.test'])).toBe(
          0,
        )
      },
    },
    {
      name: 'PATCH /api/domains/:id',
      method: 'PATCH',
      path: '/api/domains/:id',
      payload: { rootUrl: null },
      unchanged: async (id) => {
        const r = await pg.query<{ root_url: string | null }>(
          'SELECT root_url FROM domains WHERE id = $1',
          [id],
        )
        expect(r.rows[0]?.root_url).toBe('https://example.com/')
      },
    },
    {
      name: 'DELETE /api/domains/:id',
      method: 'DELETE',
      path: '/api/domains/:id',
      unchanged: async (id) => {
        expect(await rowCount('SELECT 1 FROM domains WHERE id = $1', [id])).toBe(1)
      },
    },
    {
      name: 'POST /api/domains/:id/check',
      method: 'POST',
      path: '/api/domains/:id/check',
      unchanged: async () => {
        expect(resolver.asked).toBe(0)
        expect(await rowCount('SELECT 1 FROM domain_dns_checks', [])).toBe(0)
      },
    },
    {
      name: 'POST /api/domains/:id/unverify',
      method: 'POST',
      path: '/api/domains/:id/unverify',
      unchanged: async (id) => {
        const r = await pg.query<{ verified: boolean }>(
          'SELECT verified FROM domains WHERE id = $1',
          [id],
        )
        expect(r.rows[0]?.verified).toBe(true)
      },
    },
    { name: 'GET /api/alerts', method: 'GET', path: '/api/alerts' },
  ]

  it.each(anonymous)('refuses an anonymous $name, and changes nothing', async (row) => {
    // Verified, and with a root URL, so that un-verifying and patching are
    // changes this test could see if they happened.
    const created = (await add({ host: 'go.example.test', rootUrl: 'https://example.com/' })).json()
    await pg.query('UPDATE domains SET verified = true WHERE id = $1', [created.id])
    const r = await app.inject({
      method: row.method,
      url: row.path.replace(':id', created.id),
      // Everything a request can carry except a credential: the right host,
      // and an `Origin` the cross-site check accepts.
      headers: write(),
      ...(row.payload ? { payload: row.payload } : {}),
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('unauthenticated')
    // The refusal and nothing else: no listing, no settings, no domain.
    expect(Object.keys(r.json()).sort()).toEqual(['error', 'message'])
    await row.unchanged?.(created.id)
  })
})

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
    // The column has a default that fills a token in too, so a token that
    // merely exists proves nothing about who chose it — and who chose it is
    // the whole of what the token is for. What separates the two is shape:
    // the column's default is a UUID with its dashes dropped, which fixes the
    // 13th hex digit to '4' and the 17th to one of 8, 9, a or b, while 16
    // random bytes do not. One token could take that shape by chance; a
    // score of them could not.
    const uuidShaped = (t: string): boolean => t[12] === '4' && '89ab'.includes(t[16] ?? 'z')
    for (let i = 0; i < 20; i++) await add({ host: `minted-${i}.example.test` })
    const minted = await pg.query<{ verification_token: string }>(
      'SELECT verification_token FROM domains',
    )
    expect(minted.rows).toHaveLength(21)
    expect(minted.rows.filter((row) => uuidShaped(row.verification_token))).not.toHaveLength(21)
  })

  // The interface reads `handVerified` rather than re-deriving it, so the
  // shape this route answers with is the whole of the contract.
  it('answers passedAt and handVerified, computed from verified and the last check', async () => {
    const fresh = (await add()).json()
    expect(fresh.passedAt).toBeNull()
    // Unverified, so not hand-verified either — there is nothing to call
    // "verified by hand" about a domain that answers 404.
    expect(fresh.handVerified).toBe(false)

    await pg.query(
      `INSERT INTO domains (id, host, verified, verification_token) VALUES
       ('00000000-0000-4000-8000-0000000000f1', 'byhand.example.test', true, '${'7'.repeat(32)}')`,
    )
    const list = await app.inject({ method: 'GET', url: '/api/domains', headers: read(cookie) })
    const byHand = (
      list.json().domains as { host: string; passedAt: unknown; handVerified: unknown }[]
    ).find((d) => d.host === 'byhand.example.test')
    expect(byHand?.passedAt).toBeNull()
    expect(byHand?.handVerified).toBe(true)
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

  // The same rule the CLI's `domain add` is refused by, held in the one writer
  // both of them go through. Requests for this name reach this service, so a
  // link domain of this name would be stored, verified, given a certificate and
  // then answered by this API instead of redirecting.
  it('refuses a domain with the name this API answers on, and writes nothing', async () => {
    const r = await add({ host: ADMIN_HOST })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('host_is_admin_host')
    // Nothing the refusal says gives away a password, a token or the name of a
    // constraint; and nothing was written.
    expect((await pg.query('SELECT 1 FROM domains')).rowCount).toBe(0)
    // As an operator would type it into a form, upper case and trailing dot:
    // the name is normalised before the comparison on both sides.
    const typed = await add({ host: 'Admin.Example.TEST.' })
    expect(typed.statusCode).toBe(409)
    expect(typed.json().error).toBe('host_is_admin_host')
    expect((await pg.query('SELECT 1 FROM domains')).rowCount).toBe(0)
    // Any other name on this same install is added as usual, so what was
    // refused was the collision and not the route.
    expect((await add({ host: 'links.example.test' })).statusCode).toBe(201)
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
    // The domain itself first: a row that survives keeps whatever `verified`
    // it had, so the host goes on serving and goes on renewing a certificate.
    // Its links going is the cascade, not the point.
    expect((await pg.query('SELECT 1 FROM domains')).rowCount).toBe(0)
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
    // A check that just passed for the first time: passedAt follows, and the
    // domain is no different from one verified by DNS all along.
    const after = await app.inject({ method: 'GET', url: '/api/domains', headers: read(cookie) })
    const domain = (
      after.json().domains as { id: string; passedAt: string | null; handVerified: boolean }[]
    ).find((d) => d.id === created.id)
    expect(domain?.passedAt).toBe(clock.now().toISOString())
    expect(domain?.handVerified).toBe(false)
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

  // The gate above pins that a refusal happens; this pins the number it
  // happens at. Ordering only: the resolver holds every lookup open until the
  // test lets go, so "in flight" is a fact rather than a race.
  it('runs exactly as many checks at once as it says it does', async () => {
    // The declared bound is two. It is asserted rather than merely used,
    // because a bound nothing pins is one a later change can widen silently,
    // and this one costs a DNS query per pass through the install's own
    // resolvers.
    expect(CHECKS_IN_FLIGHT).toBe(2)
    const ids: string[] = []
    for (let i = 0; i < CHECKS_IN_FLIGHT; i++) {
      ids.push((await add({ host: `busy-${i}.example.test` })).json().id)
    }
    const spare = (await add({ host: 'one-too-many.example.test' })).json()

    const release = deferred()
    const allInFlight = deferred()
    resolver.held = release.promise
    resolver.onAsked = () => {
      if (resolver.asked === CHECKS_IN_FLIGHT) allInFlight.resolve()
    }
    const check = (id: string) =>
      app.inject({ method: 'POST', url: `/api/domains/${id}/check`, headers: write(cookie) })

    const running = ids.map(check)
    await allInFlight.promise

    const refused = await check(spare.id)
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error).toBe('too_many_checks')
    // Refused before the resolver was reached, not after.
    expect(resolver.asked).toBe(CHECKS_IN_FLIGHT)

    release.resolve()
    expect((await Promise.all(running)).map((r) => r.statusCode)).toEqual(ids.map(() => 200))
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
    expect(r.json().truncated).toBe(false)
    const hosts = (r.json().domains as { host: string; status: string }[]).map(
      (d) => `${d.host}:${d.status}`,
    )
    expect(hosts).toContain(`${never.host}:never_checked`)
    expect(hosts).toContain(`${failing.host}:missing_token`)
    expect(hosts.some((h) => h.startsWith(good.host))).toBe(false)
  })

  // An operator shown a prefix of what is wrong, with nothing saying it was a
  // prefix, believes they have seen all of it.
  it('says when the alert listing was cut', async () => {
    await pg.query(
      `INSERT INTO domains (host, verification_token)
       SELECT 'bulk-' || n || '.example.test', lpad(to_hex(n), 32, '0')
         FROM generate_series(1, $1) AS n`,
      [MAX_DOMAINS_LISTED + 1],
    )
    const r = await app.inject({ method: 'GET', url: '/api/alerts', headers: read(cookie) })
    expect(r.json().domains).toHaveLength(MAX_DOMAINS_LISTED)
    expect(r.json().truncated).toBe(true)
  })

  // The four cases issue #47 draws the line between. Written directly with
  // SQL, the way `clickmonk domain add --verified` and a worker pass both
  // write: nothing over this API can mark a domain verified or plant a
  // `passed_at` of its own choosing.
  it('excludes a domain verified by hand until a check has passed for it, and re-alerts it once a passed check later fails', async () => {
    await pg.query(`INSERT INTO domains (id, host, verified, verification_token) VALUES
      ('00000000-0000-4000-8000-0000000000e1', 'untested.example.test', true, '${'1'.repeat(32)}'),
      ('00000000-0000-4000-8000-0000000000e2', 'stillbare.example.test', true, '${'2'.repeat(32)}'),
      ('00000000-0000-4000-8000-0000000000e3', 'regressed.example.test', true, '${'3'.repeat(32)}'),
      ('00000000-0000-4000-8000-0000000000e4', 'awaiting.example.test', false, '${'4'.repeat(32)}')`)
    await pg.query(`INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at, passed_at) VALUES
      -- Checked and failed, but never once passed: still hand-verified.
      ('00000000-0000-4000-8000-0000000000e2', 'missing_token', 'no record', now(), NULL),
      -- Passed once, and its most recent check failed: something changed.
      ('00000000-0000-4000-8000-0000000000e3', 'missing_token', 'record gone', now(), '2026-09-01T00:00:00.000Z')`)
    // 'untested' has no domain_dns_checks row at all: verified by hand, never checked.

    const alerts = await app.inject({ method: 'GET', url: '/api/alerts', headers: read(cookie) })
    const hosts = (alerts.json().domains as { host: string }[]).map((d) => d.host)
    expect(hosts).not.toContain('untested.example.test')
    expect(hosts).not.toContain('stillbare.example.test')
    expect(hosts).toContain('regressed.example.test')
    expect(hosts).toContain('awaiting.example.test')

    const status = await app.inject({ method: 'GET', url: '/api/status', headers: read(cookie) })
    expect(status.json().alerts).toBe(2)
  })
})
