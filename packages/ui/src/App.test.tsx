import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createClient } from './api/client'
import { createScheduler } from './api/scheduler'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ME = {
  email: 'admin@example.com',
  totpEnabled: false,
  recoveryCodesLeft: 0,
  failedLogins: 0,
  lockedUntil: null,
  credential: 'session',
}
const STATUS = { newestHour: null, reporting: 'ok', ipData: null, ipDataProblem: null, alerts: 0 }

/** Answers by path; a path the test did not name answers 500 so nothing is silently faked. */
function server(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: string[] = []
  const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0] ?? ''
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const route = routes[`${init?.method ?? 'GET'} ${path}`]
    return Promise.resolve(
      route ? route(init ?? {}) : json(500, { error: 'internal', message: 'unrouted' }),
    )
  })
  const makeClient = (onUnauthorized: () => void) =>
    createClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scheduler: createScheduler({ sleep: () => Promise.resolve() }),
      onUnauthorized,
    })
  return { calls, makeClient }
}

const show = (
  makeClient: (u: () => void) => ReturnType<typeof createClient>,
  at = '/overview',
  bootTimeoutMs = 8000,
) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <App makeClient={makeClient} bootTimeoutMs={bootTimeoutMs} />
    </MemoryRouter>,
  )

describe('what the operator sees first', () => {
  it('is the application when the session is good', async () => {
    const s = server({
      'GET /api/me': () => json(200, ME),
      'GET /api/status': () => json(200, STATUS),
    })
    show(s.makeClient)
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
  })

  it('is the sign-in screen when there is no session, and says nothing about one ending', async () => {
    const s = server({
      'GET /api/me': () => json(401, { error: 'unauthenticated', message: 'sign in' }),
    })
    show(s.makeClient)
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument()
  })

  it('says how to create the account when there is none', async () => {
    const s = server({
      'GET /api/me': () =>
        json(503, { error: 'no_admin', message: 'this install has no admin account yet' }),
    })
    show(s.makeClient)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ClickMonk has no admin account yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/admin create you@example.com/)).toBeInTheDocument()
  })

  // An unreachable service is not a reason to ask for a password: the operator
  // would type one, watch it fail too, and still not know why.
  it('says the service is not responding rather than asking for a password, and tries again', async () => {
    let up = false
    const s = server({
      'GET /api/me': () => (up ? json(200, ME) : json(502, 'Bad Gateway')),
      'GET /api/status': () => json(200, STATUS),
    })
    show(s.makeClient)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ClickMonk is not responding' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    up = true
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
  })

  it('stops waiting for a check that never answers', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('timed out', 'TimeoutError')),
        ),
      )
    const s = server({ 'GET /api/me': hang })
    show(s.makeClient, '/overview', 20)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ClickMonk is not responding' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'ClickMonk took too long to answer. Try again.',
    )
  })

  // The client calls `onUnauthorized` for any 401 other than the sign-in
  // route's own — including, in principle, one from a request the boot check
  // did not itself make. Caught here by calling the captured callback
  // directly while the boot check is still pending, rather than waiting for
  // it to answer: nothing had been signed in yet, so this must not be shown
  // as a session that ended.
  it('a stray unauthorized signal while checking does not end a session nobody had', async () => {
    let capturedOnUnauthorized: (() => void) | undefined
    const hang = () => new Promise<Response>(() => {})
    const s = server({ 'GET /api/me': hang })
    const makeClient = (onUnauthorized: () => void) => {
      capturedOnUnauthorized = onUnauthorized
      return s.makeClient(onUnauthorized)
    }
    show(makeClient, '/overview', 8000)
    await act(async () => {
      capturedOnUnauthorized?.()
    })
    expect(screen.queryByRole('heading', { level: 1, name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument()
  })
})

describe('a session that ends while the application is open', () => {
  // The session ends between the boot check and the first screen's requests:
  // every one of them answers 401. The operator sees the sign-in screen once,
  // with the reason, and no error.
  it('goes to the sign-in screen once, says why, and asks nothing more', async () => {
    const s = server({
      'GET /api/me': () => json(200, ME),
      'GET /api/status': () => json(401, { error: 'unauthenticated', message: 'sign in' }),
    })
    show(s.makeClient)
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Sign in again.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(s.calls.filter((c) => c === 'GET /api/me')).toHaveLength(1)
  })
})

describe('signing in and out', () => {
  it('signs in, checks the session, and shows the application', async () => {
    let signedIn = false
    const s = server({
      'GET /api/me': () =>
        signedIn ? json(200, ME) : json(401, { error: 'unauthenticated', message: 'sign in' }),
      'POST /api/session': () => {
        signedIn = true
        return json(200, { ok: true, expiresAt: '2026-10-24T00:00:00.000Z' })
      },
      'GET /api/status': () => json(200, STATUS),
    })
    show(s.makeClient)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a decent admin password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
  })

  it('signs out and shows the sign-in screen, without saying the session ended', async () => {
    const s = server({
      'GET /api/me': () => json(200, ME),
      'GET /api/status': () => json(200, STATUS),
      'DELETE /api/session': () => json(200, { ok: true }),
    })
    show(s.makeClient)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(s.calls).toContain('DELETE /api/session')
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument()
  })

  // The check that follows a successful sign-in reuses the same "checking"
  // phase as the boot check, which unmounts the sign-in screen (and the
  // password sitting in its state) for as long as that check is in flight.
  it('leaves the sign-in screen while the check after signing in is pending', async () => {
    let meCalls = 0
    let resolveSecondMe: ((r: Response) => void) | undefined
    const s = server({
      'GET /api/me': () => {
        meCalls += 1
        if (meCalls === 1) return json(401, { error: 'unauthenticated', message: 'sign in' })
        return new Promise<Response>((resolve) => {
          resolveSecondMe = resolve
        })
      },
      'POST /api/session': () => json(200, { ok: true, expiresAt: '2026-10-24T00:00:00.000Z' }),
    })
    show(s.makeClient)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a decent admin password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.queryByLabelText('Password')).not.toBeInTheDocument())
    resolveSecondMe?.(json(200, ME))
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
  })
})

describe('a session that does not stick after signing in', () => {
  // The service accepted the password (the POST answers 200), but the check
  // that follows still gets a 401: the browser refused the cookie, not the
  // credentials. Distinct wording from "Your session ended" — nothing here
  // had ever been signed in for a session to end.
  it('says the browser did not keep the session, distinct from one ending', async () => {
    const s = server({
      'GET /api/me': () => json(401, { error: 'unauthenticated', message: 'sign in' }),
      'POST /api/session': () => json(200, { ok: true, expiresAt: '2026-10-24T00:00:00.000Z' }),
    })
    show(s.makeClient)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a decent admin password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Signed in, but this browser did not keep the session. ClickMonk has to be opened over https.',
    )
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument()
  })
})

describe('an address with nothing at it', () => {
  it('says so, as a screen of its own', async () => {
    const s = server({
      'GET /api/me': () => json(200, ME),
      'GET /api/status': () => json(200, STATUS),
    })
    show(s.makeClient, '/no-such-screen')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Nothing here' }),
    ).toBeInTheDocument()
  })

  it('sends the root to the overview', async () => {
    const s = server({
      'GET /api/me': () => json(200, ME),
      'GET /api/status': () => json(200, STATUS),
    })
    show(s.makeClient, '/')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument(),
    )
  })
})
