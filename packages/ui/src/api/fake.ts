import { type ApiClient, ApiError, createClient } from './client'

export interface FakeCall {
  method: keyof ApiClient
  args: unknown[]
}

/**
 * A client for screen tests: every method records what it was called with,
 * and answers whatever the test gave it — or, if the test gave it nothing,
 * rejects with `not_faked` and the method's name, so a screen that asks for
 * something the test did not expect fails with a name rather than hanging on
 * a promise that never settles.
 *
 * `exportUrl` is the one method that is not a request, and it keeps the real
 * implementation, so a test can assert the address a screen links to.
 */
export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient & { calls: FakeCall[] } {
  const real = createClient({
    fetchImpl: () => Promise.reject(new Error('the fake client never fetches')),
  })
  const calls: FakeCall[] = []
  const out: Record<string, unknown> = { calls }
  for (const name of Object.keys(real) as (keyof ApiClient)[]) {
    const given = overrides[name] as ((...a: unknown[]) => unknown) | undefined
    out[name] = (...args: unknown[]) => {
      calls.push({ method: name, args })
      if (given) return given(...args)
      if (name === 'exportUrl') return (real.exportUrl as (...a: unknown[]) => unknown)(...args)
      return Promise.reject(new ApiError(500, 'not_faked', String(name)))
    }
  }
  return out as ApiClient & { calls: FakeCall[] }
}
