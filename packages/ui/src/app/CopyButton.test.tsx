import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton'

describe('copying', () => {
  it('copies the value and says so', async () => {
    const user = userEvent.setup()
    render(
      <CopyButton
        value="clickmonk-verify=0123456789abcdef0123456789abcdef"
        label="Copy the TXT value"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Copy the TXT value' }))
    expect(await navigator.clipboard.readText()).toBe(
      'clickmonk-verify=0123456789abcdef0123456789abcdef',
    )
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  // navigator.clipboard can refuse (plain http on a LAN address) or be
  // absent. A click that fails is not silence.
  it('says so when the clipboard refuses, and never claims it copied', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<CopyButton value="a-secret" label="Copy the value" />)
    await user.click(screen.getByRole('button', { name: 'Copy the value' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Could not copy. Select the value and copy it.',
    )
    expect(screen.getByRole('status')).not.toHaveTextContent('Copied')
  })

  afterEach(() => vi.restoreAllMocks())
})
