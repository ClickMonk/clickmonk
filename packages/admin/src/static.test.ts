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
    expect(r.body).toBe(INDEX)
    expect(r.headers['content-security-policy']).toBe(UI_POLICY)
  })

  it('serves a hashed file for a year', async () => {
    const r = await get('/assets/index-abc123.js')
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
    expect(r.json().error).toBe('not_found')
    expect(r.body).not.toContain('<!doctype html>')
  })

  it('answers health as it always has', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:9100' },
    })
    expect(r.json()).toEqual({ status: 'ok' })
    // A 200 under /health, the one API path a plain status check alone would
    // let through: this is what pins the onSend hook's own exclusion of API
    // paths, separately from its exclusion of every non-200 status.
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
