import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConcurrencyGate } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_HOST, clockFrom, read, signedIn, testApp } from './testing.js'

const pool = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-24T12:00:00.000Z'))
let app: FastifyInstance
let cookie = ''
let dir = ''

const COUNTRY = {
  file: 'country-0123456789abcdef.cmrt',
  version: '2026-09',
  fetchedAt: '2026-09-20T03:00:00.000Z',
  entries: { k32: 10, k128: 2 },
}
const TOR = {
  file: 'tor-fedcba9876543210.cmrt',
  version: '2026-09-24T06:00:00Z',
  fetchedAt: '2026-09-24T06:05:00.000Z',
  entries: { k32: 3, k128: 0 },
}

const manifest = (sources: Record<string, unknown>) =>
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, sources }))

const status = (on: FastifyInstance) =>
  on.inject({ method: 'GET', url: '/api/status', headers: read(cookie) })

beforeAll(async () => {
  await resetDatabases(pool, ch)
  await ch.insert({
    table: 'clicks',
    format: 'JSONEachRow',
    values: [
      {
        click_id: '01920000-0000-7000-8000-0000000000aa',
        time: '2026-09-24 11:20:00.000',
        host: 'go.example.test',
        path: '/a',
        domain_id: '00000000-0000-4000-8000-00000000000d',
        link_id: '00000000-0000-4000-8000-0000000000a1',
        outcome: 'target',
        step: 'destination',
        status: 302,
        destination: 'https://example.com/',
        target_id: '00000000-0000-4000-8000-0000000000b1',
        visitor_id: 'v1',
        returning: 0,
        country: 'DE',
        region: '',
        city: '',
        geo_source: 'dbip',
        device: 'desktop',
        user_agent: 'ua',
        referrer: '',
        ip: '198.51.100.7',
        cap_unchecked: 0,
        traffic_class: 'human',
        signals: [],
        action: '',
        os: 'windows',
        browser: 'chrome',
        asn: 64500,
      },
    ],
  })
  // Three domains: one verified by a check that found its token, one whose last
  // check did not, and one no check has reached. The last two are alerts.
  await pool.query(`INSERT INTO domains (id, host, verified) VALUES
    ('00000000-0000-4000-8000-0000000000d1', 'ok.example.test', true),
    ('00000000-0000-4000-8000-0000000000d2', 'gone.example.test', true),
    ('00000000-0000-4000-8000-0000000000d3', 'new.example.test', false)`)
  await pool.query(`INSERT INTO domain_dns_checks (domain_id, status, detail, checked_at) VALUES
    ('00000000-0000-4000-8000-0000000000d1', 'verified', '', '2026-09-24T11:00:00Z'),
    ('00000000-0000-4000-8000-0000000000d2', 'missing_token', 'no TXT record', '2026-09-24T11:00:00Z')`)
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clickmonk-status-'))
  app = testApp(pool, clock, { ch, ipdataDir: dir })
  cookie = await signedIn(app, pool, clock.now())
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  await pool.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

describe('GET /api/status', () => {
  it('says how fresh the reports and the IP lists are, and how many domains need attention', async () => {
    manifest({ country: COUNTRY, tor: TOR })
    const r = await status(app)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      newestHour: '2026-09-24T11:00:00.000Z',
      reporting: 'ok',
      ipData: {
        country: { version: '2026-09', fetchedAt: '2026-09-20T03:00:00.000Z' },
        asn: null,
        datacenter: null,
        tor: { version: '2026-09-24T06:00:00Z', fetchedAt: '2026-09-24T06:05:00.000Z' },
      },
      ipDataProblem: null,
      alerts: 2,
    })
  })

  it('says there is no IP data yet, which is not a problem', async () => {
    const r = await status(app)
    expect(r.json().ipData).toBeNull()
    expect(r.json().ipDataProblem).toBeNull()
  })

  it('says the IP data could not be read, without saying what the error was', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{"v": 2}')
    const r = await status(app)
    expect(r.statusCode).toBe(200)
    expect(r.json().ipData).toBeNull()
    expect(r.json().ipDataProblem).toBe('the IP data manifest could not be read')
    expect(r.body).not.toContain(dir)
  })

  it('treats a directory that is not there as no IP data', async () => {
    const elsewhere = testApp(pool, clock, { ch, ipdataDir: join(dir, 'not-there') })
    try {
      const r = await status(elsewhere)
      expect(r.json().ipData).toBeNull()
      expect(r.json().ipDataProblem).toBeNull()
    } finally {
      await elsewhere.close()
    }
  })

  // No test machine has `/var/lib/clickmonk/ipdata`, so an app built with no
  // `ipdataDir` at all — every suite that does not pass one — falls back to
  // that default and reads it the same way: no IP data yet, not a problem.
  it('falls back to the default directory when none is given, and finds nothing there', async () => {
    const defaulted = testApp(pool, clock, { ch })
    try {
      const r = await status(defaulted)
      expect(r.json().ipData).toBeNull()
      expect(r.json().ipDataProblem).toBeNull()
    } finally {
      await defaulted.close()
    }
  })

  it('answers when reporting does not, and says reporting is down', async () => {
    const noStore = testApp(pool, clock, { ipdataDir: dir })
    try {
      const r = await status(noStore)
      expect(r.statusCode).toBe(200)
      expect(r.json().newestHour).toBeNull()
      expect(r.json().reporting).toBe('unavailable')
      expect(r.json().alerts).toBe(2)
    } finally {
      await noStore.close()
    }
  })

  // The count is capped exactly as the listing `GET /api/alerts` answers is:
  // one query past the cap, asked for and dropped, so an install with far
  // more broken domains than this still answers a small, fast number rather
  // than counting all of them on every status read.
  it('caps the alerts count the way the alert listing caps its rows', async () => {
    await pool.query(
      `INSERT INTO domains (host, verification_token)
       SELECT 'bulk-' || n || '.example.test', lpad(to_hex(n), 32, '0')
         FROM generate_series(1, 501) AS n`,
    )
    try {
      const r = await status(app)
      expect(r.json().alerts).toBe(501)
    } finally {
      await pool.query(`DELETE FROM domains WHERE host LIKE 'bulk-%.example.test'`)
    }
  })

  it('refuses when every report slot is taken, and says when to come back', async () => {
    const full = testApp(pool, clock, { ch, ipdataDir: dir, reportGate: new ConcurrencyGate(0) })
    try {
      const r = await status(full)
      expect(r.statusCode).toBe(429)
      expect(r.json().error).toBe('too_many_reports')
      expect(r.headers['retry-after']).toBe('1')
    } finally {
      await full.close()
    }
  })

  it('needs a credential', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/status', headers: { host: ADMIN_HOST } })
    expect(r.statusCode).toBe(401)
  })

  it('refuses a query string, which means nothing here', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/status?verbose=1',
      headers: read(cookie),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_query')
  })
})
