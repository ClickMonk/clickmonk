import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApiKeys } from './ApiKeys'

const KEY = 'cmk_0123456789abcdef_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA'

function show() {
  const client = fakeClient({
    keys: () => Promise.resolve({ keys: [], truncated: false }),
    createKey: () =>
      Promise.resolve({
        id: '0123456789abcdef',
        name: 'reporting script',
        key: KEY,
        expiresAt: null,
      }),
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

  it('creates a key with a name and an optional expiry, and shows it once', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Name'), 'reporting script')
    await user.type(screen.getByLabelText('Expires after (days)'), '90')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByText(KEY)).toBeInTheDocument()
    expect(screen.getByText('This is the only time this key is shown.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'createKey').map((c) => c.args[0])).toEqual([
      { name: 'reporting script', expiresDays: 90 },
    ])
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
})
