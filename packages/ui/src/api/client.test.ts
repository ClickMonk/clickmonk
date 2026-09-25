import { describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from './client'
import { createScheduler } from './scheduler'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(respond(String(url), init ?? {})),
  )
  const onUnauthorized = vi.fn()
  const client = createClient({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    scheduler: createScheduler({ sleep: () => Promise.resolve() }),
    onUnauthorized,
  })
  return { client, fetchImpl, onUnauthorized }
}

const W = { from: '2026-09-24T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' }

describe('reads', () => {
  it('asks for a summary with exactly the window it was given', async () => {
    const { client, fetchImpl } = setup(() => json(200, { clicks: 1 }))
    await client.summary(W)
    expect(fetchImpl.mock.calls).toEqual([
      [
        '/api/reports/summary?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z',
        { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } },
      ],
    ])
  })

  // An offset of zero is a value, not an absence. A query builder that drops
  // falsy values sends no offset for UTC and would be right by accident; one
  // that drops it for a zone at +0 would be wrong the day the default changed.
  it('sends an offset of zero and a link when it has one', async () => {
    const { client, fetchImpl } = setup(() => json(200, { buckets: [] }))
    await client.timeseries({ ...W, link: '00000000-0000-4000-8000-0000000000a1' }, 'day', 0)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/reports/timeseries?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z&link=00000000-0000-4000-8000-0000000000a1&bucket=day&offset=0',
    )
  })

  it('leaves out a filter nobody set', async () => {
    const { client, fetchImpl } = setup(() => json(200, { clicks: [], nextCursor: null }))
    await client.clicks({ ...W, class: undefined, country: 'DE' }, { limit: 50 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/clicks?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z&country=DE&limit=50',
    )
  })

  it('reads a link list into a page', async () => {
    const { client, fetchImpl } = setup(() =>
      json(200, { links: [{ id: 'a' }], nextCursor: '5.b' }),
    )
    const page = await client.links({ q: '50% off', limit: 50 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/links?q=50%25+off&limit=50')
    expect(page).toEqual({ items: [{ id: 'a' }], nextCursor: '5.b' })
  })

  // The signal is what lets a screen the operator left cancel a request that
  // was already sent, so it reaches the fetch itself, on a report as on a read.
  it('hands the fetch the signal it was given', async () => {
    const { client, fetchImpl } = setup(() => json(200, {}))
    const left = new AbortController()
    await client.summary(W, left.signal)
    await client.link('00000000-0000-4000-8000-0000000000a1', { signal: left.signal })
    expect(fetchImpl.mock.calls.map((c) => c[1])).toEqual([
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: left.signal,
      },
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: left.signal,
      },
    ])
  })

  it('builds the export’s address and fetches nothing', () => {
    const { client, fetchImpl } = setup(() => json(200, {}))
    expect(client.exportUrl({ ...W, outcome: 'blocked' })).toBe(
      '/api/clicks.csv?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z&outcome=blocked',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('writes', () => {
  it('sends a body as JSON, with nothing added to it', async () => {
    const { client, fetchImpl } = setup(() => json(200, { id: 'l1' }))
    await client.updateLink('l1', { name: 'Spring' })
    expect(fetchImpl.mock.calls).toEqual([
      [
        '/api/links/l1',
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: '{"name":"Spring"}',
        },
      ],
    ])
  })

  it('sends a body with a DELETE when the route needs one', async () => {
    const { client, fetchImpl } = setup(() => json(200, { ok: true }))
    await client.disableTotp({ password: 'pw', code: '123456' })
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"password":"pw","code":"123456"}',
    })
  })

  it('escapes an id it puts in a path', async () => {
    const { client, fetchImpl } = setup(() => json(200, { ok: true }))
    await client.deleteLink('../settings')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/links/..%2Fsettings')
  })
})

describe('failures', () => {
  it('turns the service’s refusal into an error that carries its code, message and wait', async () => {
    const { client } = setup(() =>
      json(
        429,
        { error: 'too_many_attempts', message: 'try again later' },
        { 'retry-after': '120' },
      ),
    )
    const err = await client.signIn({ email: 'admin@example.com', password: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.code, err.message, err.retryAfterSeconds]).toEqual([
      429,
      'too_many_attempts',
      'try again later',
      120,
    ])
  })

  // A proxy in front of the service answers HTML. The status is the fact; a
  // JSON parse error must not replace it.
  it('keeps the status when the body is not the service’s', async () => {
    const { client } = setup(() => new Response('<html>Bad Gateway</html>', { status: 502 }))
    const err = await client.domains().catch((e) => e)
    expect([err.status, err.code, err.message]).toEqual([
      502,
      'unknown',
      'the service answered 502',
    ])
  })

  it('says the service did not answer when there was no response', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('Failed to fetch')))
    const err = await client.domains().catch((e) => e)
    expect([err.status, err.code]).toEqual([0, 'unreachable'])
  })

  it('says a request ran out of time', async () => {
    const { client } = setup(() => Promise.reject(new DOMException('timed out', 'TimeoutError')))
    const err = await client.me({ signal: AbortSignal.timeout(1) }).catch((e) => e)
    expect([err.status, err.code]).toEqual([0, 'timeout'])
  })

  it('passes an abandoned request’s abort through untouched', async () => {
    const { client } = setup(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    const err = await client.domains().catch((e) => e)
    expect(err).not.toBeInstanceOf(ApiError)
    expect(err.name).toBe('AbortError')
  })

  it('says a session has ended, once per refusal', async () => {
    const { client, onUnauthorized } = setup(() =>
      json(401, { error: 'unauthenticated', message: 'sign in' }),
    )
    await client.links({}).catch(() => {})
    await client.summary(W).catch(() => {})
    expect(onUnauthorized).toHaveBeenCalledTimes(2)
  })

  // A wrong password, or a sign-in that needs the second factor, is a 401 from
  // the sign-in route itself. That is the form's answer, not a session ending.
  it('does not treat the sign-in route’s own refusal as a session ending', async () => {
    const { client, onUnauthorized } = setup(() =>
      json(401, { error: 'totp_required', message: 'send the six-digit code' }),
    )
    const err = await client.signIn({ email: 'admin@example.com', password: 'pw' }).catch((e) => e)
    expect(err.code).toBe('totp_required')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('retries a busy report through the scheduler', async () => {
    let n = 0
    const { client, fetchImpl } = setup(() =>
      ++n < 3
        ? json(429, { error: 'too_many_reports', message: 'busy' }, { 'retry-after': '1' })
        : json(200, { clicks: 7 }),
    )
    expect(await client.summary(W)).toEqual({ clicks: 7 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  // Reports hold both slots and have not answered. A domain check is a write,
  // not a report: it is sent at once rather than queued behind them, and its
  // own 429 is shown rather than waited out.
  it('does not queue or retry a busy write, which is not a report', async () => {
    const { client, fetchImpl } = setup((url) =>
      url.startsWith('/api/reports/')
        ? new Promise<Response>(() => {})
        : json(429, { error: 'too_many_checks', message: 'busy' }, { 'retry-after': '1' }),
    )
    void client.summary(W)
    void client.summary(W)
    const check = client.checkDomain('d1').catch((e) => e)
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      '/api/reports/summary?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z',
      '/api/reports/summary?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z',
      '/api/domains/d1/check',
    ])
    expect((await check).code).toBe('too_many_checks')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
