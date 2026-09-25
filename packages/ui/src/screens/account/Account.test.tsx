import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Me } from '@/api/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Account } from './Account'

const ME: Me = {
  email: 'admin@example.com',
  totpEnabled: false,
  recoveryCodesLeft: 0,
  credential: 'session',
}

function show(me: Me = ME, over: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    sessions: () => Promise.resolve([]),
    keys: () => Promise.resolve({ keys: [], truncated: false }),
    ...over,
  })
  const onAccountChanged = vi.fn()
  render(
    <ClientProvider client={client}>
      <Account me={me} onAccountChanged={onAccountChanged} />
    </ClientProvider>,
  )
  return { client, onAccountChanged, user: userEvent.setup() }
}

describe('the account screen', () => {
  it('has the h1, the email, and a section for each part', () => {
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument()
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Password' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Two-factor authentication' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Sessions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'API keys' })).toBeInTheDocument()
  })

  it('shows the two-factor section as the service says, through me', () => {
    show({ ...ME, totpEnabled: true, recoveryCodesLeft: 7 })
    expect(screen.getByText('On. 7 recovery codes left.')).toBeInTheDocument()
  })

  it('changes the password and says how many other sessions were signed out', async () => {
    const { client, user } = show(ME, {
      changePassword: () => Promise.resolve({ ok: true as const, otherSessionsSignedOut: 2 }),
    })
    await user.type(screen.getByLabelText('Current password'), 'the old one')
    await user.type(screen.getByLabelText('New password'), 'a new decent password')
    await user.type(screen.getByLabelText('New password again'), 'a new decent password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(
      await screen.findByText('Password changed. 2 other sessions were signed out.'),
    ).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'changePassword').map((c) => c.args[0])).toEqual(
      [{ currentPassword: 'the old one', newPassword: 'a new decent password' }],
    )
  })

  it('refuses mismatched new passwords before sending anything', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Current password'), 'the old one')
    await user.type(screen.getByLabelText('New password'), 'a new decent password')
    await user.type(screen.getByLabelText('New password again'), 'a different decent password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByText('The two new passwords are not the same.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'changePassword')).toHaveLength(0)
    expect(screen.getByLabelText('New password')).toHaveValue('a new decent password')
    expect(screen.getByLabelText('New password again')).toHaveValue('a different decent password')
  })

  it('refuses a new password under 12 characters before sending anything', async () => {
    const { client, user } = show()
    await user.type(screen.getByLabelText('Current password'), 'the old one')
    await user.type(screen.getByLabelText('New password'), 'short1')
    await user.type(screen.getByLabelText('New password again'), 'short1')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByText('A password is at least 12 characters.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'changePassword')).toHaveLength(0)
    expect(screen.getByLabelText('New password')).toHaveValue('short1')
  })

  it("shows the service's refusal under Current password", async () => {
    const { user } = show(ME, {
      changePassword: () =>
        Promise.reject(new ApiError(400, 'invalid_password', 'that is not the current password')),
    })
    await user.type(screen.getByLabelText('Current password'), 'wrong one')
    await user.type(screen.getByLabelText('New password'), 'a new decent password')
    await user.type(screen.getByLabelText('New password again'), 'a new decent password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('that is not the current password')).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toHaveAttribute(
      'aria-describedby',
      'current-password-error',
    )
  })
})
