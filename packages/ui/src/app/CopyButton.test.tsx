import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
})
