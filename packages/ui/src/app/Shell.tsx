import { browserZone } from '@/app/clock'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { Freshness } from './Freshness'
import { ThemeToggle } from './ThemeToggle'
import { useRefresh } from './refresh'

const SCREENS = [
  ['/overview', 'Overview'],
  ['/links', 'Links'],
  ['/clicks', 'Clicks'],
  ['/domains', 'Domains'],
  ['/settings', 'Settings'],
  ['/account', 'Account'],
] as const

/**
 * The frame around every signed-in screen: where to go, how fresh the numbers
 * are, which zone times are in, the theme, signing out — and, in the footer,
 * the credit the IP data's licence requires wherever that data is shown.
 */
export function Shell({
  email,
  onSignOut,
  children,
}: { email: string; onSignOut: () => void; children: ReactNode }) {
  const { refresh, refreshing } = useRefresh()
  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr_auto] md:grid-cols-[13rem_1fr] md:grid-rows-[1fr_auto]">
      <nav
        aria-label="Main"
        className="min-w-0 border-b border-border bg-muted md:row-span-1 md:border-r md:border-b-0"
      >
        <p className="px-4 pt-4 font-serif text-lg font-semibold text-foreground">ClickMonk</p>
        <ul className="flex gap-1 overflow-x-auto p-2 md:grid md:overflow-visible">
          {SCREENS.map(([to, label]) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    'block rounded-md px-3 py-2 text-sm whitespace-nowrap',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="grid min-w-0 content-start gap-6 p-4 md:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <Freshness />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{`Times in ${browserZone()}`}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
              // The cue that replaced the dimmed content must not itself be
              // dimmed: the button base fades every disabled control to
              // disabled:opacity-50, so this overrides it back to full
              // contrast while "Refreshing…" is the reason it is disabled.
              className="disabled:opacity-100"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <ThemeToggle />
            <Button type="button" variant="ghost" size="sm" onClick={onSignOut} title={email}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="min-w-0">{children}</main>
      </div>
      <footer className="border-t border-border px-4 py-3 text-xs text-muted-foreground md:col-span-2">
        IP geolocation by{' '}
        <a className="underline" href="https://db-ip.com">
          DB-IP
        </a>
        , licensed under{' '}
        <a className="underline" href="https://creativecommons.org/licenses/by/4.0/">
          CC BY 4.0
        </a>
        . ClickMonk converts it to its own lookup format.
      </footer>
    </div>
  )
}
