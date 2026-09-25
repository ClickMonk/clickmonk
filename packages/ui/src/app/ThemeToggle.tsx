import { Moon, Sun } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

/** Read by `public/theme.js` before first paint as well; the two must agree on this key. */
export const THEME_KEY = 'cm-theme'

type Choice = 'system' | 'light' | 'dark'

function stored(): Choice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

const systemDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false

/**
 * Follows the system's scheme while the page is open. Read once at render, a
 * change of the system scheme would leave the button naming and drawing the
 * theme the page already shows, and pressing it would change nothing.
 */
const subscribeToSystem = (onChange: () => void): (() => void) => {
  const q = window.matchMedia?.(DARK_QUERY)
  q?.addEventListener('change', onChange)
  return () => q?.removeEventListener('change', onChange)
}

/**
 * Light or dark. The button names the theme it switches to, because an icon for
 * the current one is ambiguous about which it is telling you. The choice is
 * stored and applied as `data-theme`, which the tokens read; no choice leaves
 * the attribute off and the system decides.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(stored)
  const dark = useSyncExternalStore(subscribeToSystem, systemDark)
  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)
    try {
      if (choice === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, choice)
    } catch {
      // A browser that refuses storage keeps the choice for this page only.
    }
  }, [choice])
  const applied = choice === 'system' ? (dark ? 'dark' : 'light') : choice
  const target = applied === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
      className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={() => setChoice(target)}
    >
      {target === 'dark' ? (
        <Moon className="size-4" aria-hidden="true" />
      ) : (
        <Sun className="size-4" aria-hidden="true" />
      )}
    </button>
  )
}
