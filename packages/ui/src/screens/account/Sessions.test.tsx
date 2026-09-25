import { ClientProvider } from '@/api/context'
import { fakeClient } from '@/api/fake'
import type { Session } from '@/api/types'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Sessions } from './Sessions'

const session = (id: string, current: boolean): Session => ({
  id,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-07T02:00:00.000Z',
  expiresAt: '2026-10-31T00:00:00.000Z',
  userAgent: current ? 'Mozilla/5.0 (Macintosh) Firefox/131' : 'Mozilla/5.0 (iPhone) Safari/605',
  ip: current ? '203.0.113.7' : '2001:db8::7',
  current,
})

function show() {
  const client = fakeClient({
    sessions: () => Promise.resolve([session('s1', true), session('s2', false)]),
    revokeSession: () => Promise.resolve({ ok: true as const }),
  })
  render(
    <ClientProvider client={client}>
      <Sessions />
    </ClientProvider>,
  )
  return { client, user: userEvent.setup() }
}

describe('sessions', () => {
  it('lists each session with where it was opened from, and marks this one', async () => {
    show()
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByText('This browser')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('203.0.113.7')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Signed in from' })).toBeInTheDocument()
  })

  it('revokes another session after asking', async () => {
    const { client, user } = show()
    const rows = await screen.findAllByRole('row')
    await user.click(within(rows[2] as HTMLElement).getByRole('button', { name: 'Sign out' }))
    await user.click(screen.getByRole('button', { name: 'Sign that session out' }))
    expect(client.calls.filter((c) => c.method === 'revokeSession').map((c) => c.args)).toEqual([
      ['s2'],
    ])
  })

  it('says that signing out this session signs this browser out', async () => {
    const { user } = show()
    const rows = await screen.findAllByRole('row')
    await user.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Sign out' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('This browser is signed out.')
  })

  // The reload after revoking this browser's own session is what reaches the
  // service and comes back 401; without it the application never learns.
  it('asks for the list again after any revoke, this browser’s own included', async () => {
    const { client, user } = show()
    const rows = await screen.findAllByRole('row')
    await user.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Sign out' }))
    await user.click(screen.getByRole('button', { name: 'Sign this browser out' }))
    await waitFor(() => expect(client.calls.filter((c) => c.method === 'sessions')).toHaveLength(2))
    expect(client.calls.filter((c) => c.method === 'revokeSession').map((c) => c.args)).toEqual([
      ['s1'],
    ])
  })
})
