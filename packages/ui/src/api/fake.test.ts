import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { fakeClient } from './fake'

describe('the fake client', () => {
  it('rejects a call nobody faked, naming the method', async () => {
    const client = fakeClient()
    const err = await client.domains().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.code, err.message]).toEqual([500, 'not_faked', 'domains'])
    expect(client.calls).toEqual([{ method: 'domains', args: [] }])
  })

  it('answers a faked call and records what it was called with', async () => {
    const client = fakeClient({ deleteLink: () => Promise.resolve({ ok: true as const }) })
    expect(await client.deleteLink('00000000-0000-4000-8000-0000000000a1')).toEqual({ ok: true })
    expect(client.calls).toEqual([
      { method: 'deleteLink', args: ['00000000-0000-4000-8000-0000000000a1'] },
    ])
  })

  // Not a request, so nothing to fake: a screen test asserts the real address.
  it('keeps the real export address', () => {
    const client = fakeClient()
    expect(
      client.exportUrl({
        from: '2026-09-24T00:00:00.000Z',
        to: '2026-09-25T00:00:00.000Z',
        country: 'DE',
      }),
    ).toBe(
      '/api/clicks.csv?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z&country=DE',
    )
  })
})
