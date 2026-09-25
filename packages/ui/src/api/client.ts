/**
 * The only place this package calls `fetch`.
 *
 * Every request is same-origin with the cookie the browser holds; a write
 * carries an `Origin` header because every browser adds one to a same-origin
 * request that is not a GET, and the service requires exactly that. Nothing
 * here sets it, and nothing here needs a token: the cookie is `SameSite=Strict`
 * and the service answers no cross-origin request at all.
 *
 * Every failure becomes an `ApiError` with the service's own code and message,
 * or a code of this module's when the service never said anything: `unknown`
 * for a body that is not the service's (a proxy's error page), `unreachable`
 * for no response, `timeout` for a request that ran out of time. An abort the
 * interface caused is rethrown as it is, so that nothing shows an error for a
 * request the operator navigated away from.
 *
 * Any 401 other than the sign-in route's own calls `onUnauthorized`: a session
 * that ended is a state of the whole interface, not an error of one panel.
 */
import { ApiError } from './errors'
import { type Scheduler, createScheduler } from './scheduler'
import type {
  Alert,
  ApiKey,
  Breakdown,
  ClickCount,
  ClickFilters,
  ClickPage,
  Domain,
  DomainCheck,
  Link,
  LinkInput,
  LinkPatch,
  Me,
  NewApiKey,
  Page,
  Session,
  Settings,
  SettingsInput,
  SignIn,
  Status,
  Summary,
  Timeseries,
  WindowQuery,
} from './types'

export { REPORT_RETRIES, REPORTS_IN_FLIGHT } from './scheduler'

export { ApiError }

type Query = Record<string, string | number | boolean | undefined | null>

/** A query string from the values that are set. Zero and false are values. */
function qs(q: Query): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.append(k, String(v))
  const s = p.toString()
  return s === '' ? '' : `?${s}`
}

const id = (value: string): string => encodeURIComponent(value)

async function errorOf(res: Response): Promise<ApiError> {
  const retry = Number(res.headers.get('retry-after'))
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : undefined
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body.error === 'string' && typeof body.message === 'string') {
      return new ApiError(res.status, body.error, body.message, retryAfter)
    }
  } catch {
    // Not the service's JSON: fall through to the status alone.
  }
  return new ApiError(res.status, 'unknown', `the service answered ${res.status}`, retryAfter)
}

export type ApiClient = ReturnType<typeof createClient>

export function createClient(
  o: { fetchImpl?: typeof fetch; scheduler?: Scheduler; onUnauthorized?: () => void } = {},
) {
  const fetchImpl = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const scheduler = o.scheduler ?? createScheduler()

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers:
        opts.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    }
    let res: Response
    try {
      res = await fetchImpl(path, init)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new ApiError(0, 'timeout', 'ClickMonk took too long to answer')
      }
      throw new ApiError(0, 'unreachable', 'ClickMonk did not answer')
    }
    if (!res.ok) {
      const err = await errorOf(res)
      if (res.status === 401 && path !== '/api/session') o.onUnauthorized?.()
      throw err
    }
    return (await res.json()) as T
  }

  const report = <T>(path: string, signal?: AbortSignal): Promise<T> =>
    scheduler.run(() => call<T>('GET', path, { signal }), signal)

  const windowOf = (w: WindowQuery): Query => ({ from: w.from, to: w.to, link: w.link })
  const filtersOf = (f: ClickFilters): Query => ({
    ...windowOf(f),
    class: f.class,
    outcome: f.outcome,
    country: f.country,
  })

  return {
    // The account and its credentials.
    me: (opts: { signal?: AbortSignal } = {}) => call<Me>('GET', '/api/me', opts),
    signIn: (body: SignIn) =>
      call<{ ok: true; expiresAt: string }>('POST', '/api/session', { body }),
    signOut: () => call<{ ok: true }>('DELETE', '/api/session'),
    sessions: () => call<{ sessions: Session[] }>('GET', '/api/sessions').then((r) => r.sessions),
    revokeSession: (sessionId: string) =>
      call<{ ok: true }>('DELETE', `/api/sessions/${id(sessionId)}`),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      call<{ ok: true; otherSessionsSignedOut: number }>('POST', '/api/password', { body }),
    startTotp: (body: { password: string; code?: string; recoveryCode?: string }) =>
      call<{ secret: string; uri: string }>('POST', '/api/totp', { body }),
    confirmTotp: (body: { password: string; code: string }) =>
      call<{ ok: true; recoveryCodes: string[] }>('POST', '/api/totp/confirm', { body }),
    disableTotp: (body: { password: string; code?: string; recoveryCode?: string }) =>
      call<{ ok: true }>('DELETE', '/api/totp', { body }),
    newRecoveryCodes: (body: { password: string; code?: string; recoveryCode?: string }) =>
      call<{ recoveryCodes: string[] }>('POST', '/api/totp/recovery-codes', { body }),
    keys: () => call<{ keys: ApiKey[]; truncated: boolean }>('GET', '/api/keys'),
    createKey: (body: { name: string; expiresDays?: number }) =>
      call<NewApiKey>('POST', '/api/keys', { body }),
    revokeKey: (keyId: string) => call<{ ok: true }>('DELETE', `/api/keys/${id(keyId)}`),

    // Domains.
    domains: () => call<{ domains: Domain[]; truncated: boolean }>('GET', '/api/domains'),
    addDomain: (body: { host: string; rootUrl?: string | null; notFoundUrl?: string | null }) =>
      call<Domain>('POST', '/api/domains', { body }),
    updateDomain: (
      domainId: string,
      body: { rootUrl?: string | null; notFoundUrl?: string | null },
    ) => call<Domain>('PATCH', `/api/domains/${id(domainId)}`, { body }),
    deleteDomain: (domainId: string) =>
      call<{ ok: true }>('DELETE', `/api/domains/${id(domainId)}`),
    checkDomain: (domainId: string) =>
      call<DomainCheck>('POST', `/api/domains/${id(domainId)}/check`),
    unverifyDomain: (domainId: string) =>
      call<{ ok: true; note: string }>('POST', `/api/domains/${id(domainId)}/unverify`),
    alerts: () => call<{ domains: Alert[]; truncated: boolean }>('GET', '/api/alerts'),

    // Links.
    links: async (q: { domain?: string; q?: string; limit?: number; cursor?: string }): Promise<
      Page<Link>
    > => {
      const r = await call<{ links: Link[]; nextCursor: string | null }>(
        'GET',
        `/api/links${qs({ domain: q.domain, q: q.q, limit: q.limit, cursor: q.cursor })}`,
      )
      return { items: r.links, nextCursor: r.nextCursor }
    },
    link: (linkId: string, opts: { signal?: AbortSignal } = {}) =>
      call<Link>('GET', `/api/links/${id(linkId)}`, opts),
    createLink: (body: LinkInput) => call<Link>('POST', '/api/links', { body }),
    updateLink: (linkId: string, body: LinkPatch) =>
      call<Link>('PATCH', `/api/links/${id(linkId)}`, { body }),
    deleteLink: (linkId: string) => call<{ ok: true }>('DELETE', `/api/links/${id(linkId)}`),

    // Settings.
    settings: () => call<Settings>('GET', '/api/settings'),
    putSettings: (body: SettingsInput) => call<Settings>('PUT', '/api/settings', { body }),

    // Reports, through the scheduler.
    summary: (w: WindowQuery, signal?: AbortSignal) =>
      report<Summary>(`/api/reports/summary${qs(windowOf(w))}`, signal),
    timeseries: (w: WindowQuery, bucket: 'hour' | 'day', offset: number, signal?: AbortSignal) =>
      report<Timeseries>(
        `/api/reports/timeseries${qs({ ...windowOf(w), bucket, offset })}`,
        signal,
      ),
    breakdown: (w: WindowQuery, dimension: string, limit: number, signal?: AbortSignal) =>
      report<Breakdown>(
        `/api/reports/breakdown${qs({ ...windowOf(w), dimension, limit })}`,
        signal,
      ),
    clicks: (f: ClickFilters, page: { limit: number; cursor?: string }, signal?: AbortSignal) =>
      report<ClickPage>(
        `/api/clicks${qs({ ...filtersOf(f), limit: page.limit, cursor: page.cursor })}`,
        signal,
      ),
    clickCount: (f: ClickFilters, signal?: AbortSignal) =>
      report<ClickCount>(`/api/clicks/count${qs(filtersOf(f))}`, signal),
    status: (signal?: AbortSignal) => report<Status>('/api/status', signal),

    /** The export's address. A navigation, never a fetch: the browser streams it to disk. */
    exportUrl: (f: ClickFilters): string => `/api/clicks.csv${qs(filtersOf(f))}`,
  }
}
