import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SignIn } from './SignIn'

function setup(signIn: (body: unknown) => Promise<unknown>) {
  const client = fakeClient({ signIn: signIn as never })
  const onSignedIn = vi.fn()
  render(
    <ClientProvider client={client}>
      <SignIn onSignedIn={onSignedIn} ended={false} />
    </ClientProvider>,
  )
  return { client, onSignedIn, user: userEvent.setup() }
}

const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('Email'), 'admin@example.com')
  await user.type(screen.getByLabelText('Password'), 'a decent admin password')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

const bodies = (client: ReturnType<typeof fakeClient>) =>
  client.calls.filter((c) => c.method === 'signIn').map((c) => c.args[0])

describe('the sign-in screen', () => {
  it('is titled as a screen', () => {
    setup(() => Promise.resolve({ ok: true }))
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
  })

  it('sends the email and the password and nothing else', async () => {
    const { client, onSignedIn, user } = setup(() => Promise.resolve({ ok: true }))
    await fill(user)
    expect(bodies(client)).toEqual([
      { email: 'admin@example.com', password: 'a decent admin password' },
    ])
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('asks for the code only when the service says it needs one, and sends the same request with it', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(401, 'totp_required', 'send the six-digit code from your authenticator app'),
      )
      .mockResolvedValueOnce({ ok: true })
    const { client, onSignedIn, user } = setup(signIn)
    expect(screen.queryByLabelText('Code from your authenticator app')).not.toBeInTheDocument()
    await fill(user)
    await user.type(await screen.findByLabelText('Code from your authenticator app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(bodies(client)).toEqual([
      { email: 'admin@example.com', password: 'a decent admin password' },
      { email: 'admin@example.com', password: 'a decent admin password', code: '123456' },
    ])
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('takes a recovery code instead, and sends it as one', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, 'totp_required', 'send the six-digit code'))
      .mockResolvedValueOnce({ ok: true })
    const { client, user } = setup(signIn)
    await fill(user)
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }))
    await user.type(screen.getByLabelText('Recovery code'), 'ABCDE-FGHJK')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(bodies(client)[1]).toEqual({
      email: 'admin@example.com',
      password: 'a decent admin password',
      recoveryCode: 'ABCDE-FGHJK',
    })
  })

  it('says a wrong password is wrong, keeps the email and clears the password', async () => {
    const { user } = setup(() =>
      Promise.reject(
        new ApiError(401, 'invalid_credentials', 'that email and password do not match'),
      ),
    )
    await fill(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'that email and password do not match',
    )
    expect(screen.getByLabelText('Email')).toHaveValue('admin@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })

  it('says how long a locked account must wait', async () => {
    const { user } = setup(() =>
      Promise.reject(
        new ApiError(
          429,
          'locked',
          'too many failed attempts; this account is locked for a while',
          300,
        ),
      ),
    )
    await fill(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'too many failed attempts; this account is locked for a while. Try again in 5 minutes.',
    )
  })

  it('sends one request however often it is pressed while one is in flight', async () => {
    let finish: (v: unknown) => void = () => {}
    const { client, user } = setup(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'pw')
    const button = screen.getByRole('button', { name: 'Sign in' })
    await user.click(button)
    await user.click(button)
    expect(bodies(client)).toHaveLength(1)
    finish({ ok: true })
  })

  it('says where the first account is made', () => {
    setup(() => Promise.resolve({ ok: true }))
    expect(
      screen.getByText(/No account yet\? It is created on the server with clickmonk admin create/),
    ).toBeInTheDocument()
  })

  it('says a session ended when that is why it is here', () => {
    render(
      <ClientProvider client={fakeClient()}>
        <SignIn onSignedIn={() => {}} ended />
      </ClientProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Sign in again.')
  })

  it('says a session was not kept, distinct from one that ended, when that is why it is here', () => {
    render(
      <ClientProvider client={fakeClient()}>
        <SignIn onSignedIn={() => {}} ended={false} notKept />
      </ClientProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Signed in, but this browser did not keep the session. ClickMonk has to be opened over https.',
    )
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument()
  })
})
