import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from '@clickmonk/db'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAdminApp } from './app.js'
import { ADMIN_HOST, ORIGIN } from './testing.js'

const API_POLICY = "default-src 'none'; frame-ancestors 'none'"
// Written out by hand, not imported from static.ts: a test that compares a
// response header to the same constant the production code sets can never
// catch a change to that constant.
const UI_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'"
const INDEX = '<!doctype html><title>ClickMonk</title><div id="root"></div>'
const noPool = new Proxy(
  {},
  {
    get: () => {
      throw new Error('this test must not reach the database')
    },
  },
) as Pool

let dir = ''
let app: FastifyInstance

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { host: ADMIN_HOST, ...headers } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clickmonk-ui-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  writeFileSync(join(dir, 'theme.js'), '/* theme */')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  app = buildAdminApp(
    { pg: noPool, adminHost: ADMIN_HOST, uiDir: dir, log: false },
    { trustProxy: false },
  )
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the interface', () => {
  it('is the page at the root, under its own policy, never cached', async () => {
    const r = await get('/')
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe(INDEX)
    expect(r.headers['content-security-policy']).toBe(UI_POLICY)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('is the page at a client route', async () => {
    const r = await get('/links/00000000-0000-4000-8000-0000000000a1/edit')
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe(INDEX)
    expect(r.headers['content-security-policy']).toBe(UI_POLICY)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('serves a hashed file for a year', async () => {
    const r = await get('/assets/index-abc123.js')
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(r.headers['content-security-policy']).toBe(UI_POLICY)
  })

  it("keys the hashed cache rule off the route that matched, not the request's raw spelling", async () => {
    // Percent-encoded but the same file: Fastify still routes it to the
    // static plugin's own /assets/index-abc123.js route. A header decision
    // keyed off the raw URL string would miss this and answer uncached.
    const r = await get('/%61ssets/index-abc123.js')
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(r.headers['content-security-policy']).toBe(UI_POLICY)
  })

  it('serves the theme script uncached', async () => {
    const r = await get('/theme.js')
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('answers a missing file 404 in JSON, not with the page', async () => {
    const r = await get('/assets/index-gone999.js')
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'not_found', message: 'no such route' })
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
  })

  it('refuses everything under /assets/ that is not a real file, not with the page', async () => {
    // No dot in the last segment, so a plain "looks like a file" check would
    // miss this — nothing under /assets/ is ever a client route, whatever its
    // last segment looks like, because a hashed year-long cache is the wrong
    // answer for a page.
    const r = await get('/assets/foo')
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'not_found', message: 'no such route' })
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('keeps every other security header on the page', async () => {
    const r = await get('/')
    expect([
      r.headers['x-frame-options'],
      r.headers['x-content-type-options'],
      r.headers['referrer-policy'],
    ]).toEqual(['DENY', 'nosniff', 'no-referrer'])
    expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
  })
})

describe('the API, unchanged', () => {
  it('answers an unknown API route in JSON, under its own policy', async () => {
    const r = await get('/api/nope')
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'not_found', message: 'no such route' })
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
  })

  it('answers a refusal under its own policy', async () => {
    const r = await get('/api/me')
    expect(r.statusCode).toBe(401)
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
  })

  it('excludes an API 200 from the interface policy, not just every non-200', async () => {
    // Every other API test here is a refusal or a 404, so a check that only
    // excludes API paths from non-200 statuses would still pass them all. A
    // route with nothing to refuse is the only way to see a real API 200.
    app.get('/api/probe', async () => ({ ok: true }))
    const r = await get('/api/probe')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it("keys that exclusion off the route that matched, not the request's raw spelling", async () => {
    // Percent-encoded but the same route: Fastify still dispatches it to
    // /api/probe. A header decision keyed off the raw URL string would miss
    // this and hand the interface's policy to an API response.
    app.get('/api/probe', async () => ({ ok: true }))
    const r = await get('/%61pi/probe')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('does not serve the page for a write, which the cross-site check refuses first without an origin', async () => {
    const bare = await app.inject({ method: 'POST', url: '/links', headers: { host: ADMIN_HOST } })
    expect(bare.statusCode).toBe(403)
    const withOrigin = await app.inject({
      method: 'POST',
      url: '/links',
      headers: { host: ADMIN_HOST, origin: ORIGIN },
    })
    expect(withOrigin.statusCode).toBe(404)
    expect(withOrigin.json()).toEqual({ error: 'not_found', message: 'no such route' })
  })

  it('does not serve the page on another host name', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { host: 'go.example.test' } })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'not_found', message: 'no such host on this service' })
  })

  it('answers health as it always has', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:9100' },
    })
    expect(r.json()).toEqual({ status: 'ok' })
    // Every 200 from an API path is excluded the same way, pinned above by
    // the probe route; /health is the one that needs no database, so it is
    // worth its own check alongside the body it has always answered.
    expect(r.headers['content-security-policy']).toBe(API_POLICY)
  })
})

describe('an install with no built interface', () => {
  it('answers the API alone, and the root is a JSON 404', async () => {
    const bare = buildAdminApp(
      { pg: noPool, adminHost: ADMIN_HOST, uiDir: join(dir, 'nowhere'), log: false },
      { trustProxy: false },
    )
    try {
      const r = await bare.inject({ method: 'GET', url: '/', headers: { host: ADMIN_HOST } })
      expect(r.statusCode).toBe(404)
      expect(r.json()).toEqual({ error: 'not_found', message: 'no such route' })
    } finally {
      await bare.close()
    }
  })
})
