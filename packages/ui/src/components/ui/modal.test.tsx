import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Modal } from './modal'

describe('the dialog while closed', () => {
  it('renders nothing inside it', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Secret">
        <p>secret</p>
      </Modal>,
    )
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })
})
