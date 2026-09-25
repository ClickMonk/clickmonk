import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TwoFactor } from './TwoFactor'

const CODES = [
  'ABCDE-FGHJK',
  'MNPQR-STVWX',
  'Y0123-45678',
  '9ABCD-EFGHJ',
  'KMNPQ-RSTVW',
  'XY012-34567',
  '89ABC-DEFGH',
  'JKMNP-QRSTV',
  'WXY01-23456',
  '789AB-CDEFG',
]

function show(enabled: boolean, over: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    startTotp: () =>
      Promise.resolve({
        secret: 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      }),
    confirmTotp: () => Promise.resolve({ ok: true as const, recoveryCodes: CODES }),
    disableTotp: () => Promise.resolve({ ok: true as const }),
    newRecoveryCodes: () => Promise.resolve({ recoveryCodes: CODES }),
    ...over,
  })
  const onChanged = vi.fn()
  render(
    <ClientProvider client={client}>
      <TwoFactor enabled={enabled} recoveryCodesLeft={enabled ? 7 : 0} onChanged={onChanged} />
    </ClientProvider>,
  )
  return { client, onChanged, user: userEvent.setup() }
}

const bodies = (client: ReturnType<typeof fakeClient>, method: string) =>
  client.calls.filter((c) => c.method === method).map((c) => c.args[0])

/** The one currently-open dialog, the way jsdom's polyfilled `<dialog>` tracks it (see test-setup.ts). */
const openDialog = () => document.querySelector('dialog[open]') as HTMLDialogElement

describe('turning two-factor on', () => {
  it('asks for the password, shows the code to scan and the key to type, and confirms with a code', async () => {
    const { client, onChanged, user } = show(false)
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'a decent admin password')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument()
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    expect(await screen.findByText('ABCDE-FGHJK')).toBeInTheDocument()
    expect(bodies(client, 'startTotp')).toEqual([{ password: 'a decent admin password' }])
    expect(bodies(client, 'confirmTotp')).toEqual([
      { password: 'a decent admin password', code: '123456' },
    ])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the recovery codes once, and they are gone when the dialog closes', async () => {
    const { user } = show(false)
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    expect(
      await screen.findByText('This is the only time these codes are shown.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I have saved them' }))
    expect(document.body.textContent).not.toContain('ABCDE-FGHJK')
    expect(document.body.textContent).not.toContain('JBSWY3DPEHPK3PXP')
    expect(localStorage.length).toBe(0)
  })

  it('says a wrong code is wrong and keeps the enrolment open', async () => {
    const { user } = show(false, {
      confirmTotp: () =>
        Promise.reject(new ApiError(400, 'invalid_code', 'that code does not match the secret')),
    })
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Code from the app'), '000000')
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'that code does not match the secret',
    )
    expect(
      screen.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument()
  })

  it('refuses an empty code before confirming, and sends nothing', async () => {
    const { client, user } = show(false)
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByLabelText('Code from the app')
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    expect(screen.getByText('Enter the code from the app.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'confirmTotp')).toHaveLength(0)
    expect(
      screen.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument()
  })

  it('clears the enrolment secret and uri when the dialog is closed by Escape, and does not show them again on reopen', async () => {
    const { user } = show(false)
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'a decent admin password')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    // jsdom's polyfilled close() is what Escape and a method="dialog" form
    // both do in a real browser: remove `open` and fire `close` (test-setup.ts).
    act(() => openDialog().close())
    expect(document.body.textContent).not.toContain('JBSW Y3DP EHPK 3PXP')
    expect(document.body.textContent).not.toContain('JBSWY3DPEHPK3PXP')
    expect(document.body.textContent).not.toContain('otpauth://')
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    expect(screen.getByLabelText('Your password')).toHaveValue('')
    expect(screen.queryByText('JBSW Y3DP EHPK 3PXP')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('img', { name: 'QR code for your authenticator app' }),
    ).not.toBeInTheDocument()
  })

  it('clears the recovery codes when the dialog is closed by Escape', async () => {
    const { user } = show(false)
    await user.click(screen.getByRole('button', { name: 'Set up an authenticator app' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    expect(await screen.findByText('ABCDE-FGHJK')).toBeInTheDocument()
    act(() => openDialog().close())
    expect(document.body.textContent).not.toContain('ABCDE-FGHJK')
  })
})

describe('once two-factor is on', () => {
  it('says how many recovery codes are left', () => {
    show(true)
    expect(screen.getByText('On. 7 recovery codes left.')).toBeInTheDocument()
  })

  it('turns it off with the password and a code from the app, and tells the caller', async () => {
    const { client, onChanged, user } = show(true)
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.type(screen.getByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Turn it off' }))
    expect(bodies(client, 'disableTotp')).toEqual([{ password: 'pw', code: '123456' }])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty code before turning it off, and sends nothing', async () => {
    const { client, user } = show(true)
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Turn it off' }))
    expect(screen.getByText('Enter the code from the app.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'disableTotp')).toHaveLength(0)
  })

  it('clears a client-side refusal once the dialog closes, rather than showing it again on reopen', async () => {
    const { user } = show(true)
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Turn it off' }))
    expect(screen.getByText('Enter the code from the app.')).toBeInTheDocument()
    act(() => openDialog().close())
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    expect(screen.queryByText('Enter the code from the app.')).not.toBeInTheDocument()
  })

  it('shows the service refusal when turning it off fails', async () => {
    const { user } = show(true, {
      // confirmSecondFactor answers a wrong code with 403 (session-routes.ts).
      disableTotp: () =>
        Promise.reject(new ApiError(403, 'invalid_code', 'that code does not match this account')),
    })
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.type(screen.getByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Turn it off' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'that code does not match this account',
    )
  })

  it('takes a recovery code instead of a code from the app, and tells the caller', async () => {
    const { client, onChanged, user } = show(true)
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }))
    await user.type(screen.getByLabelText('Recovery code'), 'ABCDE-FGHJK')
    await user.click(screen.getByRole('button', { name: 'Replace the codes' }))
    expect(bodies(client, 'newRecoveryCodes')).toEqual([
      { password: 'pw', recoveryCode: 'ABCDE-FGHJK' },
    ])
    expect(await screen.findByText('MNPQR-STVWX')).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty recovery code before replacing the codes, and sends nothing', async () => {
    const { client, user } = show(true)
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }))
    await user.click(screen.getByRole('button', { name: 'Replace the codes' }))
    expect(screen.getByText('Enter the recovery code.')).toBeInTheDocument()
    expect(client.calls.filter((c) => c.method === 'newRecoveryCodes')).toHaveLength(0)
  })

  it('shows the service refusal when replacing recovery codes fails', async () => {
    const { user } = show(true, {
      newRecoveryCodes: () =>
        Promise.reject(new ApiError(403, 'invalid_code', 'that code does not match this account')),
    })
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }))
    await user.type(screen.getByLabelText('Your password'), 'pw')
    await user.type(screen.getByLabelText('Code from the app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Replace the codes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'that code does not match this account',
    )
  })
})
