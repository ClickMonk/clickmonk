import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import type { ApiKey } from '@/api/types'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApiKeys } from './ApiKeys'

const KEY = 'cmk_0123456789abcdef_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA'

const EXISTING: ApiKey = {
  id: '0123456789abcdef',
  name: 'ci token',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

function show(over: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    keys: () => Promise.resolve({ keys: [], truncated: false }),
    createKey: () =>
      Promise.resolve({
        id: '0123456789abcdef',
        name: 'reporting script',
        key: KEY,
        expiresAt: null,
      }),
    ...over,
  })
  render(
    <ClientProvider client={client}>
      <ApiKeys />
    </ClientProvider>,
  )
  return { client, user: userEvent.setup() }
}

describe('API keys', () => {
  it('says what a key can and cannot do', () => {
    show()
    expect(
      screen.getByText(
        /A key can read and change domains, links and settings, and read reports\. It cannot sign in/,
      ),
    ).toBeInTheDocument()
  })

  it('creates a key with a name and an optional expiry, shows it once, and reloads the list', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Name'), 'reporting script')
    await user.type(screen.getByLabelText('Expires after (days)'), '90')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByText(KEY)).toBeInTheDocument()
    expect(screen.getByText('This is the only time this key is shown.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'createKey').map((c) => c.args[0])).toEqual([
      { name: 'reporting script', expiresDays: 90 },
    ])
    await waitFor(() => expect(client.calls.filter((c) => c.method === 'keys')).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(document.body.textContent).not.toContain(KEY)
  })

  it('sends no expiry when none is given', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Name'), 'forever')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText(KEY)
    expect(client.calls.find((c) => c.method === 'createKey')?.args[0]).toEqual({ name: 'forever' })
  })

  it('clears the new key when the dialog is closed by Escape', async () => {
    const { user } = show()
    await user.type(screen.getByLabelText('Name'), 'reporting script')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByText(KEY)).toBeInTheDocument()
    // jsdom's polyfilled close() is what Escape and a method="dialog" form
    // both do in a real browser: remove `open` and fire `close` (test-setup.ts).
    act(() => (document.querySelector('dialog[open]') as HTMLDialogElement).close())
    expect(document.body.textContent).not.toContain(KEY)
  })

  it('refuses a name outside 1 to 100 characters, and sends nothing', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Expires after (days)'), '30')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(screen.getByText('A name is 1 to 100 characters.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'createKey')).toHaveLength(0)
    expect(screen.getByLabelText('Expires after (days)')).toHaveValue('30')
  })

  it('refuses an expiry outside 1 to 3,650 days, and sends nothing', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Name'), 'ci token')
    await user.type(screen.getByLabelText('Expires after (days)'), '5000')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(screen.getByText('A whole number of days from 1 to 3,650.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'createKey')).toHaveLength(0)
    expect(screen.getByLabelText('Name')).toHaveValue('ci token')
  })

  it('revokes a key after confirming, and reloads the list', async () => {
    const { client, user } = show({
      keys: () => Promise.resolve({ keys: [EXISTING], truncated: false }),
      revokeKey: () => Promise.resolve({ ok: true as const }),
    })
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(client.calls.filter((c) => c.method === 'revokeKey').map((c) => c.args)).toEqual([
      ['0123456789abcdef'],
    ])
    await waitFor(() => expect(client.calls.filter((c) => c.method === 'keys')).toHaveLength(2))
  })

  it('puts the list command in code formatting when the list is truncated', async () => {
    show({ keys: () => Promise.resolve({ keys: [EXISTING], truncated: true }) })
    const code = await screen.findByText('clickmonk apikey list')
    expect(code.tagName).toBe('CODE')
  })

  it('marks the list busy while a reload is in flight, without losing the rows', async () => {
    let resolveSecond: ((k: { keys: ApiKey[]; truncated: boolean }) => void) | undefined
    let calls = 0
    const { user } = show({
      keys: (() => {
        calls += 1
        if (calls === 1) return Promise.resolve({ keys: [EXISTING], truncated: false })
        return new Promise<{ keys: ApiKey[]; truncated: boolean }>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
      revokeKey: () => Promise.resolve({ ok: true as const }),
    })
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Revoke key' }))
    const table = screen.getByRole('table')
    await waitFor(() => expect(table.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true'))
    resolveSecond?.({ keys: [EXISTING], truncated: false })
    await waitFor(() => expect(table.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'))
  })
})
