import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  describe('with no stored choice', () => {
    afterEach(() => vi.unstubAllGlobals())

    /** A system scheme that can change while the page is open, as a real one can. */
    function systemScheme(initiallyDark: boolean) {
      let dark = initiallyDark
      const listeners = new Set<() => void>()
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() {
          return query === '(prefers-color-scheme: dark)' && dark
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }))
      return {
        listeners,
        set(next: boolean) {
          dark = next
          for (const l of listeners) l()
        },
      }
    }

    it('follows the system scheme when it changes while the page is open', () => {
      const system = systemScheme(false)
      const { unmount } = render(<ThemeToggle />)
      expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
      act(() => system.set(true))
      expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
      act(() => system.set(false))
      expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
      // Unmounted, it stops listening: nothing is left subscribed to the system.
      expect(system.listeners.size).toBeGreaterThan(0)
      unmount()
      expect(system.listeners.size).toBe(0)
    })
  })
})
