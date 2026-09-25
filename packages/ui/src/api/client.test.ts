import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiError, createClient } from './client'
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

// Every method, one row each: the exact address and request it sends, and what
// it hands back from what the service answered. A method added to the client
// without a row here fails the first test below.
const READ = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
const write = (method: string, body?: string) =>
  body === undefined
    ? { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
    : {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
      }

const LINK = '00000000-0000-4000-8000-0000000000a1'
const DOMAIN = '00000000-0000-4000-8000-0000000000d1'
const WINDOW_QS = 'from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z'

type Row = {
  call: (c: ApiClient) => Promise<unknown>
  url: string
  init: unknown
  answer: unknown
  result: unknown
}

const ROWS: Record<Exclude<keyof ApiClient, 'exportUrl'>, Row> = {
  me: {
    call: (c) => c.me(),
    url: '/api/me',
    init: READ,
    answer: {
      email: 'admin@example.com',
      totpEnabled: false,
      recoveryCodesLeft: 0,
      credential: 'session',
    },
    result: {
      email: 'admin@example.com',
      totpEnabled: false,
      recoveryCodesLeft: 0,
      credential: 'session',
    },
  },
  signIn: {
    call: (c) => c.signIn({ email: 'admin@example.com', password: 'pw', code: '123456' }),
    url: '/api/session',
    init: write('POST', '{"email":"admin@example.com","password":"pw","code":"123456"}'),
    answer: { ok: true, expiresAt: '2026-10-24T10:00:00.000Z' },
    result: { ok: true, expiresAt: '2026-10-24T10:00:00.000Z' },
  },
  signOut: {
    call: (c) => c.signOut(),
    url: '/api/session',
    init: write('DELETE'),
    answer: { ok: true },
    result: { ok: true },
  },
  sessions: {
    call: (c) => c.sessions(),
    url: '/api/sessions',
    init: READ,
    answer: { sessions: [{ id: 's1', current: true }] },
    result: [{ id: 's1', current: true }],
  },
  revokeSession: {
    call: (c) => c.revokeSession('s/1'),
    url: '/api/sessions/s%2F1',
    init: write('DELETE'),
    answer: { ok: true },
    result: { ok: true },
  },
  changePassword: {
    call: (c) => c.changePassword({ currentPassword: 'old', newPassword: 'a new password' }),
    url: '/api/password',
    init: write('POST', '{"currentPassword":"old","newPassword":"a new password"}'),
    answer: { ok: true, otherSessionsSignedOut: 2 },
    result: { ok: true, otherSessionsSignedOut: 2 },
  },
  startTotp: {
    call: (c) => c.startTotp({ password: 'pw' }),
    url: '/api/totp',
    init: write('POST', '{"password":"pw"}'),
    answer: { secret: 'ABCDEFGH', uri: 'otpauth://totp/x?secret=ABCDEFGH' },
    result: { secret: 'ABCDEFGH', uri: 'otpauth://totp/x?secret=ABCDEFGH' },
  },
  confirmTotp: {
    call: (c) => c.confirmTotp({ password: 'pw', code: '654321' }),
    url: '/api/totp/confirm',
    init: write('POST', '{"password":"pw","code":"654321"}'),
    answer: { ok: true, recoveryCodes: ['aaaa-bbbb'] },
    result: { ok: true, recoveryCodes: ['aaaa-bbbb'] },
  },
  disableTotp: {
    call: (c) => c.disableTotp({ password: 'pw', recoveryCode: 'aaaa-bbbb' }),
    url: '/api/totp',
    init: write('DELETE', '{"password":"pw","recoveryCode":"aaaa-bbbb"}'),
    answer: { ok: true },
    result: { ok: true },
  },
  newRecoveryCodes: {
    call: (c) => c.newRecoveryCodes({ password: 'pw', code: '111111' }),
    url: '/api/totp/recovery-codes',
    init: write('POST', '{"password":"pw","code":"111111"}'),
    answer: { recoveryCodes: ['cccc-dddd'] },
    result: { recoveryCodes: ['cccc-dddd'] },
  },
  keys: {
    call: (c) => c.keys(),
    url: '/api/keys',
    init: READ,
    answer: { keys: [{ id: 'k1' }], truncated: false },
    result: { keys: [{ id: 'k1' }], truncated: false },
  },
  createKey: {
    call: (c) => c.createKey({ name: 'backup script', expiresDays: 30 }),
    url: '/api/keys',
    init: write('POST', '{"name":"backup script","expiresDays":30}'),
    answer: { id: 'k2', name: 'backup script', key: 'made-up-key', expiresAt: null },
    result: { id: 'k2', name: 'backup script', key: 'made-up-key', expiresAt: null },
  },
  revokeKey: {
    call: (c) => c.revokeKey('k2'),
    url: '/api/keys/k2',
    init: write('DELETE'),
    answer: { ok: true },
    result: { ok: true },
  },
  domains: {
    call: (c) => c.domains(),
    url: '/api/domains',
    init: READ,
    answer: { domains: [{ id: DOMAIN }], truncated: true },
    result: { domains: [{ id: DOMAIN }], truncated: true },
  },
  addDomain: {
    call: (c) => c.addDomain({ host: 'go.example.com', rootUrl: null }),
    url: '/api/domains',
    init: write('POST', '{"host":"go.example.com","rootUrl":null}'),
    answer: { id: DOMAIN, host: 'go.example.com' },
    result: { id: DOMAIN, host: 'go.example.com' },
  },
  updateDomain: {
    call: (c) => c.updateDomain(DOMAIN, { notFoundUrl: 'https://example.com/missing' }),
    url: `/api/domains/${DOMAIN}`,
    init: write('PATCH', '{"notFoundUrl":"https://example.com/missing"}'),
    answer: { id: DOMAIN, notFoundUrl: 'https://example.com/missing' },
    result: { id: DOMAIN, notFoundUrl: 'https://example.com/missing' },
  },
  deleteDomain: {
    call: (c) => c.deleteDomain(DOMAIN),
    url: `/api/domains/${DOMAIN}`,
    init: write('DELETE'),
    answer: { ok: true },
    result: { ok: true },
  },
  checkDomain: {
    call: (c) => c.checkDomain(DOMAIN),
    url: `/api/domains/${DOMAIN}/check`,
    init: write('POST'),
    answer: { status: 'missing_token', detail: null },
    result: { status: 'missing_token', detail: null },
  },
  unverifyDomain: {
    call: (c) => c.unverifyDomain(DOMAIN),
    url: `/api/domains/${DOMAIN}/unverify`,
    init: write('POST'),
    answer: { ok: true, note: 'links on this domain now answer 404' },
    result: { ok: true, note: 'links on this domain now answer 404' },
  },
  alerts: {
    call: (c) => c.alerts(),
    url: '/api/alerts',
    init: READ,
    answer: { domains: [{ id: DOMAIN, status: 'never_checked' }], truncated: false },
    result: { domains: [{ id: DOMAIN, status: 'never_checked' }], truncated: false },
  },
  links: {
    call: (c) => c.links({ domain: 'go.example.com', q: 'spring', limit: 20, cursor: '5.b' }),
    url: '/api/links?domain=go.example.com&q=spring&limit=20&cursor=5.b',
    init: READ,
    answer: { links: [{ id: LINK }], nextCursor: null },
    result: { items: [{ id: LINK }], nextCursor: null },
  },
  link: {
    call: (c) => c.link(LINK),
    url: `/api/links/${LINK}`,
    init: READ,
    answer: { id: LINK, slug: 'spring' },
    result: { id: LINK, slug: 'spring' },
  },
  createLink: {
    call: (c) =>
      c.createLink({
        host: 'go.example.com',
        slug: 'spring',
        targets: [{ url: 'https://example.com/a' }],
      }),
    url: '/api/links',
    init: write(
      'POST',
      '{"host":"go.example.com","slug":"spring","targets":[{"url":"https://example.com/a"}]}',
    ),
    answer: { id: LINK, slug: 'spring' },
    result: { id: LINK, slug: 'spring' },
  },
  updateLink: {
    call: (c) => c.updateLink(LINK, { enabled: false, password: null }),
    url: `/api/links/${LINK}`,
    init: write('PATCH', '{"enabled":false,"password":null}'),
    answer: { id: LINK, enabled: false },
    result: { id: LINK, enabled: false },
  },
  deleteLink: {
    call: (c) => c.deleteLink(LINK),
    url: `/api/links/${LINK}`,
    init: write('DELETE'),
    answer: { ok: true },
    result: { ok: true },
  },
  settings: {
    call: (c) => c.settings(),
    url: '/api/settings',
    init: READ,
    answer: { retention: null, note: null, problem: 'the settings row is missing' },
    result: { retention: null, note: null, problem: 'the settings row is missing' },
  },
  putSettings: {
    call: (c) =>
      c.putSettings({
        traffic: {
          actions: { bot: 'flag', abuser: 'block', anonymous: 'nothing', datacenter: 'safe' },
          safeUrl: 'https://example.com/safe',
          abuserThreshold: 60,
        },
        retention: { rawRetentionDays: 90, ipRetentionDays: null },
      }),
    url: '/api/settings',
    init: write(
      'PUT',
      '{"traffic":{"actions":{"bot":"flag","abuser":"block","anonymous":"nothing","datacenter":"safe"},"safeUrl":"https://example.com/safe","abuserThreshold":60},"retention":{"rawRetentionDays":90,"ipRetentionDays":null}}',
    ),
    answer: { note: 'raw clicks are kept 90 days', problem: null },
    result: { note: 'raw clicks are kept 90 days', problem: null },
  },
  summary: {
    call: (c) => c.summary({ ...W, link: LINK }),
    url: `/api/reports/summary?${WINDOW_QS}&link=${LINK}`,
    init: READ,
    answer: { clicks: 3, visitors: 2 },
    result: { clicks: 3, visitors: 2 },
  },
  timeseries: {
    call: (c) => c.timeseries(W, 'day', 10),
    url: `/api/reports/timeseries?${WINDOW_QS}&bucket=day&offset=10`,
    init: READ,
    answer: { bucket: 'day', buckets: [] },
    result: { bucket: 'day', buckets: [] },
  },
  breakdown: {
    call: (c) => c.breakdown(W, 'country', 10),
    url: `/api/reports/breakdown?${WINDOW_QS}&dimension=country&limit=10`,
    init: READ,
    answer: { dimension: 'country', rows: [{ value: 'DE', clicks: 4, visitors: 3 }] },
    result: { dimension: 'country', rows: [{ value: 'DE', clicks: 4, visitors: 3 }] },
  },
  clicks: {
    call: (c) =>
      c.clicks(
        { ...W, link: LINK, class: 'bot', outcome: 'blocked', country: 'DE' },
        { limit: 25, cursor: '9.c' },
      ),
    url: `/api/clicks?${WINDOW_QS}&link=${LINK}&class=bot&outcome=blocked&country=DE&limit=25&cursor=9.c`,
    init: READ,
    answer: { clicks: [], nextCursor: null },
    result: { clicks: [], nextCursor: null },
  },
  clickCount: {
    call: (c) => c.clickCount({ ...W, class: 'human', outcome: 'target', country: 'FR' }),
    url: `/api/clicks/count?${WINDOW_QS}&class=human&outcome=target&country=FR`,
    init: READ,
    answer: { count: 12, cap: 1000000, truncated: false },
    result: { count: 12, cap: 1000000, truncated: false },
  },
  status: {
    call: (c) => c.status(),
    url: '/api/status',
    init: READ,
    answer: { reporting: 'ok', alerts: 1 },
    result: { reporting: 'ok', alerts: 1 },
  },
}

describe('every method', () => {
  it('has a row here, and only exportUrl is not a request', () => {
    const { client } = setup(() => json(200, {}))
    expect(Object.keys(client).sort()).toEqual([...Object.keys(ROWS), 'exportUrl'].sort())
  })

  it.each(Object.entries(ROWS))(
    '%s sends exactly its request and hands back its answer',
    async (_name, row) => {
      const { client, fetchImpl } = setup(() => json(200, row.answer))
      expect(await row.call(client)).toEqual(row.result)
      expect(fetchImpl.mock.calls).toEqual([[row.url, row.init]])
    },
  )
})

describe('the report queue', () => {
  // Two summaries hold both slots and never answer. Every other report waits
  // behind them rather than being sent.
  it('holds status, breakdowns, the click log and its count behind the reports in flight', async () => {
    const { client, fetchImpl } = setup(() => new Promise<Response>(() => {}))
    void client.summary(W)
    void client.summary(W)
    void client.status()
    void client.breakdown(W, 'country', 10)
    void client.clicks(W, { limit: 25 })
    void client.clickCount(W)
    void client.timeseries(W, 'day', 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      `/api/reports/summary?${WINDOW_QS}`,
      `/api/reports/summary?${WINDOW_QS}`,
    ])
  })
})

describe('edges', () => {
  it('treats a 401 on signing out as a session that ended', async () => {
    const { client, onUnauthorized } = setup(() =>
      json(401, { error: 'unauthenticated', message: 'sign in' }),
    )
    const err = await client.signOut().catch((e) => e)
    expect(err.code).toBe('unauthenticated')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('keeps the status when a success is not the service’s JSON', async () => {
    const { client } = setup(() => new Response('<html>Welcome to nginx</html>', { status: 200 }))
    const err = await client.domains().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.code, err.message]).toEqual([
      200,
      'unknown',
      'the service answered 200',
    ])
  })

  // An empty search box and an empty domain filter are no filter: the route
  // refuses both as values.
  it('sends no search and no domain for an empty one', async () => {
    const { client, fetchImpl } = setup(() => json(200, { links: [], nextCursor: null }))
    await client.links({ q: '', domain: '', limit: 50 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/links?limit=50')
  })
})
