import { Button } from '@/components/ui/button'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Confirm } from './Confirm'

describe('confirming a destructive action', () => {
  it('names the consequence and the action, and does nothing until confirmed', async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    render(
      <Confirm
        title="Delete go.example.test?"
        body="Its 12 links, their targets and their counters are deleted with it."
        action="Delete domain"
        destructive
        onConfirm={onConfirm}
        trigger={<Button variant="destructive">Delete</Button>}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Its 12 links, their targets and their counters',
    )
    expect(onConfirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete domain' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open and says why when the action fails', async () => {
    const { ApiError } = await import('@/api/errors')
    render(
      <Confirm
        title="Revoke this key?"
        body="Scripts using it stop working."
        action="Revoke key"
        onConfirm={() =>
          Promise.reject(new ApiError(404, 'not_found', 'no such key, or it was already revoked'))
        }
        trigger={<Button>Revoke</Button>}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no such key, or it was already revoked',
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
})
