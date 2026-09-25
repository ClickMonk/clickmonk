import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ThemeToggle } from './ThemeToggle'

describe('the theme', () => {
  it('offers the other theme, stores the choice and applies it', async () => {
    render(<ThemeToggle />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(localStorage.getItem('cm-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })

  it('starts from what is stored', () => {
    localStorage.setItem('cm-theme', 'dark')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })
})
