import { AttemptCounter, newRecoveryCode, newTotpSecret, totpCode, totpStep } from '@clickmonk/core'
import { resetDatabases, testCh, testPg } from '@clickmonk/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountExistsError, createAccount, lockoutMs, signIn } from './account.js'
import { LOGIN_ATTEMPT_LIMIT, LOGIN_ATTEMPT_WINDOW_MS } from './app.js'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  clockFrom,
  cookieFrom,
  read,
  signedIn,
  testApp,
  write,
} from './testing.js'

const pg = testPg()
const ch = testCh()
const clock = clockFrom(new Date('2026-09-23T10:00:00.000Z'))
let app: FastifyInstance

beforeAll(async () => {
  await resetDatabases(pg, ch)
})

beforeEach(async () => {
  clock.set(new Date('2026-09-23T10:00:00.000Z'))
  await pg.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  app = testApp(pg, clock)
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

const signInWith = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/session', headers: write(), payload })

describe('creating the one admin account', () => {
  it('refuses a second, rather than replacing the first', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    await expect(
      createAccount(pg, { email: 'other@example.com', password: 'another good password' }),
    ).rejects.toThrow(AccountExistsError)
    const r = await pg.query<{ email: string }>('SELECT email FROM admin_account')
    expect(r.rows[0]?.email).toBe(ADMIN_EMAIL)
  })

  it('stores the address lower-cased, and never the password', async () => {
    await createAccount(pg, { email: '  Admin@Example.COM ', password: ADMIN_PASSWORD })
    const r = await pg.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM admin_account',
    )
    expect(r.rows[0]?.email).toBe('admin@example.com')
    expect(r.rows[0]?.password_hash).not.toContain('decent')
  })
})

describe('signing in', () => {
  it('answers the same refusal for an unknown address and a wrong password', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const wrongEmail = await signInWith({ email: 'nobody@example.com', password: ADMIN_PASSWORD })
    const wrongPassword = await signInWith({ email: ADMIN_EMAIL, password: 'not the password' })
    expect(wrongEmail.statusCode).toBe(401)
    expect(wrongPassword.statusCode).toBe(401)
    expect(wrongEmail.json()).toEqual(wrongPassword.json())
    expect(wrongEmail.headers['set-cookie']).toBeUndefined()
  })

  it('says so when the install has no admin account yet', async () => {
    const r = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(r.statusCode).toBe(503)
    expect(r.json().error).toBe('no_admin')
  })

  it('locks the account after five failures, for longer each time', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    for (let i = 0; i < 5; i++) {
      const r = await signInWith({ email: ADMIN_EMAIL, password: 'wrong' })
      expect(r.statusCode, `attempt ${i}`).toBe(401)
    }
    // The right password does not get in while the lock stands.
    const locked = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error).toBe('locked')
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    // And it lifts on its own.
    clock.advance(lockoutMs(5) + 1000)
    const after = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(after.statusCode).toBe(200)
    // A success clears the count, so the next failure starts from one.
    const row = await pg.query<{ failed_logins: number; locked_until: Date | null }>(
      'SELECT failed_logins, locked_until FROM admin_account',
    )
    expect(row.rows[0]).toEqual({ failed_logins: 0, locked_until: null })
  })

  it('grows the lockout to an hour and no further', () => {
    expect(lockoutMs(4)).toBe(0)
    expect(lockoutMs(5)).toBe(5 * 60 * 1000)
    expect(lockoutMs(6)).toBe(10 * 60 * 1000)
    expect(lockoutMs(100)).toBe(60 * 60 * 1000)
  })

  // The per-address bound, shown on its own. With the shipped numbers the
  // account locks at five and answers 429 `locked` for every attempt after
  // that, so a test that just made ten attempts would pass whether this
  // limiter ran or not. Two failures against a counter of two reaches it while
  // the account is still unlocked, and the assertion is the exact code.
  it('refuses one address after too many attempts, before the password is even checked', async () => {
    const attempts = new AttemptCounter(2, LOGIN_ATTEMPT_WINDOW_MS)
    const limited = testApp(pg, clock, { loginAttempts: attempts })
    try {
      await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      const attempt = (password: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/session',
          headers: write(),
          payload: { email: ADMIN_EMAIL, password },
        })
      expect((await attempt('wrong')).statusCode).toBe(401)
      expect((await attempt('wrong')).statusCode).toBe(401)
      const refused = await attempt(ADMIN_PASSWORD)
      expect(refused.statusCode).toBe(429)
      expect(refused.json().error).toBe('too_many_attempts')
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
      // Two failures is below LOCKOUT_AFTER, so the account itself is not
      // locked: this refusal is the address limiter's and nothing else's.
      const row = await pg.query<{ locked_until: Date | null }>(
        'SELECT locked_until FROM admin_account',
      )
      expect(row.rows[0]?.locked_until).toBeNull()
      // And the window turning over gives the address its allowance back.
      clock.advance(LOGIN_ATTEMPT_WINDOW_MS + 1000)
      expect((await attempt(ADMIN_PASSWORD)).statusCode).toBe(200)
    } finally {
      await limited.close()
    }
  })

  // LOGIN_ATTEMPT_LIMIT is the shipped number; this pins that it is what the
  // app is built with, which the test above deliberately does not use.
  it('is built with the documented per-address limit', () => {
    expect(LOGIN_ATTEMPT_LIMIT).toBe(10)
    expect(LOGIN_ATTEMPT_WINDOW_MS).toBe(15 * 60 * 1000)
  })

  // The counter runs on a monotonic clock. Walking the wall clock backwards —
  // NTP, a hand on the host, a VM restored from a snapshot — must not turn the
  // window over, because that is a lockout an attacker can clear by making the
  // host's clock move. `clock.set` moves only the wall clock; `clock.advance`
  // moves both.
  it('does not forget an address because the wall clock went backwards', async () => {
    const attempts = new AttemptCounter(1, LOGIN_ATTEMPT_WINDOW_MS)
    const limited = testApp(pg, clock, { loginAttempts: attempts })
    try {
      await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      const attempt = (password: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/session',
          headers: write(),
          payload: { email: ADMIN_EMAIL, password },
        })
      expect((await attempt('wrong')).statusCode).toBe(401)
      expect((await attempt(ADMIN_PASSWORD)).statusCode).toBe(429)

      // A year backwards on the wall clock, which a Date.now() counter would
      // read as a window that began in the future and start again on.
      clock.set(new Date('2025-09-23T10:00:00.000Z'))
      const afterTheJump = await attempt(ADMIN_PASSWORD)
      expect(afterTheJump.statusCode).toBe(429)
      expect(afterTheJump.json().error).toBe('too_many_attempts')

      // Real elapsed time still clears it.
      clock.advance(LOGIN_ATTEMPT_WINDOW_MS + 1000)
      expect((await attempt(ADMIN_PASSWORD)).statusCode).toBe(200)
    } finally {
      await limited.close()
    }
  })

  it('records the session with the device and address it came from', async () => {
    await createAccount(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const r = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...write(), 'user-agent': 'A browser' },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    expect(r.statusCode).toBe(200)
    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: read(cookieFrom(r.headers['set-cookie'])),
    })
    expect(list.json().sessions).toHaveLength(1)
    expect(list.json().sessions[0].userAgent).toBe('A browser')
    expect(list.json().sessions[0].current).toBe(true)
  })

  it('removes sessions that have run out, when someone signs in', async () => {
    const cookie = await signedIn(app, pg)
    expect(cookie).toContain('cm_admin=')
    await pg.query("UPDATE sessions SET expires_at = now() - interval '1 day'")
    await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const rows = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions')
    expect(rows.rows[0]?.n).toBe(1)
  })
})

describe('two-factor authentication', () => {
  /** Enrols and returns the secret and the recovery codes. */
  async function enrol(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
    const start = await app.inject({
      method: 'POST',
      url: '/api/totp',
      headers: write(cookie),
      payload: { password: ADMIN_PASSWORD },
    })
    expect(start.statusCode).toBe(200)
    const secret = start.json().secret as string
    expect(start.json().uri).toContain('otpauth://totp/')
    // No `secret` in the confirm body: the server enrols the one it minted.
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/totp/confirm',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(secret, totpStep(clock.now().getTime())),
      },
    })
    expect(confirm.statusCode).toBe(200)
    return { secret, recoveryCodes: confirm.json().recoveryCodes as string[] }
  }

  it('is off until a code proves the app holds the secret', async () => {
    const cookie = await signedIn(app, pg)
    const start = await app.inject({
      method: 'POST',
      url: '/api/totp',
      headers: write(cookie),
      payload: { password: ADMIN_PASSWORD },
    })
    // The secret is pending, not live: an interrupted enrolment leaves the
    // account exactly as it was, and the pending value is the server's own.
    const row = await pg.query<{ totp_secret: string | null; totp_pending_secret: string | null }>(
      'SELECT totp_secret, totp_pending_secret FROM admin_account',
    )
    expect(row.rows[0]?.totp_secret).toBeNull()
    expect(row.rows[0]?.totp_pending_secret).toBe(start.json().secret)
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/totp/confirm',
      headers: write(cookie),
      payload: { password: ADMIN_PASSWORD, code: '000000' },
    })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error).toBe('invalid_code')
    expect(
      (await pg.query<{ totp_secret: string | null }>('SELECT totp_secret FROM admin_account'))
        .rows[0]?.totp_secret,
    ).toBeNull()
  })

  // The secret is the server's. There is no request field that names one, so a
  // client cannot enrol a secret it chose — and confirming without having
  // started is refused rather than treated as an enrolment of something.
  it('enrols only the secret it minted, and never one a body names', async () => {
    const cookie = await signedIn(app, pg)
    const chosen = newTotpSecret()
    const smuggled = await app.inject({
      method: 'POST',
      url: '/api/totp/confirm',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        secret: chosen,
        code: totpCode(chosen, totpStep(clock.now().getTime())),
      },
    })
    // Strict body: there is no `secret` field to send.
    expect(smuggled.statusCode).toBe(400)
    expect(smuggled.json().error).toBe('invalid_body')

    const noEnrolment = await app.inject({
      method: 'POST',
      url: '/api/totp/confirm',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(chosen, totpStep(clock.now().getTime())),
      },
    })
    expect(noEnrolment.statusCode).toBe(400)
    expect(noEnrolment.json().error).toBe('no_enrolment')
    expect(
      (await pg.query<{ totp_secret: string | null }>('SELECT totp_secret FROM admin_account'))
        .rows[0]?.totp_secret,
    ).toBeNull()
  })

  // Once a second factor exists, the password alone must not be able to
  // replace it or remove it — otherwise a stolen session plus the password is
  // a full bypass by way of disable-then-enrol.
  it('needs the current factor to re-enrol or to turn off, and takes a recovery code for it', async () => {
    const cookie = await signedIn(app, pg)
    const { secret, recoveryCodes } = await enrol(cookie)

    for (const [method, url] of [
      ['POST', '/api/totp'],
      ['DELETE', '/api/totp'],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: write(cookie),
        payload: { password: ADMIN_PASSWORD },
      })
      expect(r.statusCode, url).toBe(403)
      expect(r.json().error, url).toBe('totp_required')
      const wrongCode = await app.inject({
        method,
        url,
        headers: write(cookie),
        payload: { password: ADMIN_PASSWORD, code: '000000' },
      })
      expect(wrongCode.statusCode, url).toBe(403)
      expect(wrongCode.json().error, url).toBe('invalid_code')
    }
    // Still enrolled after all four refusals.
    expect(
      (await pg.query<{ totp_secret: string | null }>('SELECT totp_secret FROM admin_account'))
        .rows[0]?.totp_secret,
    ).toBe(secret)

    // A code from the authenticator starts a replacement...
    clock.advance(60_000)
    const replacing = await app.inject({
      method: 'POST',
      url: '/api/totp',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(secret, totpStep(clock.now().getTime())),
      },
    })
    expect(replacing.statusCode).toBe(200)

    // ...and a recovery code is the other way in, for an app that is gone.
    const off = await app.inject({
      method: 'DELETE',
      url: '/api/totp',
      headers: write(cookie),
      payload: { password: ADMIN_PASSWORD, recoveryCode: recoveryCodes[0] },
    })
    expect(off.statusCode).toBe(200)
    expect(
      (await pg.query<{ totp_secret: string | null }>('SELECT totp_secret FROM admin_account'))
        .rows[0]?.totp_secret,
    ).toBeNull()
  })

  // The password comes first on every one of these, before the second factor
  // is even looked at, so a wrong password never says whether a factor exists.
  it('needs the password again to enrol, to disable, or to replace the codes', async () => {
    const cookie = await signedIn(app, pg)
    for (const [method, url] of [
      ['POST', '/api/totp'],
      ['DELETE', '/api/totp'],
      ['POST', '/api/totp/recovery-codes'],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: write(cookie),
        payload: { password: 'not the password' },
      })
      expect(r.statusCode, url).toBe(403)
      expect(r.json().error, url).toBe('invalid_password')
    }
  })

  // A session cookie is not a bound. A wrong password here costs the account
  // exactly what a wrong password at the sign-in form costs, so a cookie taken
  // off a shared machine is not an oracle.
  it('counts a wrong password behind a session, and locks the account on it', async () => {
    const cookie = await signedIn(app, pg)
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/password',
        headers: write(cookie),
        payload: { currentPassword: 'not the password', newPassword: 'a new decent password' },
      })
      expect(r.statusCode, `attempt ${i}`).toBe(403)
      expect(r.json().error, `attempt ${i}`).toBe('invalid_password')
    }
    const row = await pg.query<{ failed_logins: number; locked_until: Date | null }>(
      'SELECT failed_logins, locked_until FROM admin_account',
    )
    expect(row.rows[0]?.failed_logins).toBe(5)
    expect(row.rows[0]?.locked_until).not.toBeNull()

    // The lock is the account's, so it stops the right password here...
    const locked = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(cookie),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'a new decent password' },
    })
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error).toBe('locked')
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    // ...and the sign-in form too: one lockout, not two.
    const signIn_ = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(signIn_.statusCode).toBe(429)
    expect(signIn_.json().error).toBe('locked')

    // And it lifts, after which the change goes through.
    clock.advance(lockoutMs(5) + 1000)
    const changed = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(cookie),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'a new decent password' },
    })
    expect(changed.statusCode).toBe(200)
  })

  // The other bound on the same path, shown on its own with a counter of one.
  it('refuses a password check behind a session once the counter is spent', async () => {
    const attempts = new AttemptCounter(1, LOGIN_ATTEMPT_WINDOW_MS)
    const limited = testApp(pg, clock, { loginAttempts: attempts })
    try {
      const cookie = await signedIn(limited, pg)
      const ask = (currentPassword: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/password',
          headers: write(cookie),
          payload: { currentPassword, newPassword: 'a new decent password' },
        })
      expect((await ask('not the password')).statusCode).toBe(403)
      const refused = await ask(ADMIN_PASSWORD)
      expect(refused.statusCode).toBe(429)
      expect(refused.json().error).toBe('too_many_attempts')
      // One failure is below LOCKOUT_AFTER, so this is the counter's refusal.
      const row = await pg.query<{ locked_until: Date | null }>(
        'SELECT locked_until FROM admin_account',
      )
      expect(row.rows[0]?.locked_until).toBeNull()
    } finally {
      await limited.close()
    }
  })

  it('then asks for a code at every sign-in', async () => {
    const cookie = await signedIn(app, pg)
    const { secret } = await enrol(cookie)
    const withoutCode = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(withoutCode.statusCode).toBe(401)
    expect(withoutCode.json().error).toBe('totp_required')
    // A wrong code is a wrong credential, and counts as one.
    const wrong = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      code: '000000',
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json().error).toBe('invalid_credentials')
    expect(
      (await pg.query<{ failed_logins: number }>('SELECT failed_logins FROM admin_account')).rows[0]
        ?.failed_logins,
    ).toBe(1)
    clock.advance(60_000)
    const right = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      code: totpCode(secret, totpStep(clock.now().getTime())),
    })
    expect(right.statusCode).toBe(200)
  })

  // A code seen over a shoulder, or read out of a proxy log, is already spent.
  it('accepts a code once, and refuses every step at or below it', async () => {
    const cookie = await signedIn(app, pg)
    const { secret } = await enrol(cookie)
    clock.advance(60_000)
    const code = totpCode(secret, totpStep(clock.now().getTime())) as string
    const first = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code })
    expect(first.statusCode).toBe(200)
    const replay = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code })
    expect(replay.statusCode).toBe(401)
    // The step before this one is refused too, although it is inside the window.
    const previous = totpCode(secret, totpStep(clock.now().getTime()) - 1) as string
    expect(
      (await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: previous }))
        .statusCode,
    ).toBe(401)
    // The next step still works.
    clock.advance(30_000)
    const next = totpCode(secret, totpStep(clock.now().getTime())) as string
    expect(
      (await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: next })).statusCode,
    ).toBe(200)
  })

  it('takes each recovery code once', async () => {
    const cookie = await signedIn(app, pg)
    const { recoveryCodes } = await enrol(cookie)
    expect(recoveryCodes).toHaveLength(10)
    const code = recoveryCodes[0] as string
    const first = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: code,
    })
    expect(first.statusCode).toBe(200)
    const again = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: code,
    })
    expect(again.statusCode).toBe(401)
    // Another one still works, and only the used one is marked.
    const second = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: recoveryCodes[1] as string,
    })
    expect(second.statusCode).toBe(200)
    const left = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(left.json().recoveryCodesLeft).toBe(8)
  })

  it('refuses a recovery code this install never issued, and one from an old set', async () => {
    const cookie = await signedIn(app, pg)
    const { recoveryCodes } = await enrol(cookie)
    const stranger = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: newRecoveryCode(),
    })
    expect(stranger.statusCode).toBe(401)
    const replaced = await app.inject({
      method: 'POST',
      url: '/api/totp/recovery-codes',
      headers: write(cookie),
      payload: { password: ADMIN_PASSWORD },
    })
    expect(replaced.statusCode).toBe(200)
    const old = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: recoveryCodes[2] as string,
    })
    expect(old.statusCode).toBe(401)
    const fresh = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: (replaced.json().recoveryCodes as string[])[0] as string,
    })
    expect(fresh.statusCode).toBe(200)
  })

  // The other door to the same rule, and the one the test above does not
  // reach: replacing the authenticator app issues a fresh set of codes, and
  // the set printed for the app it replaced must die with it. Asking for new
  // codes outright and enrolling a new secret are two different writes, so a
  // test of one says nothing about the other.
  it('takes the previous set of recovery codes with a fresh enrolment', async () => {
    const cookie = await signedIn(app, pg)
    const { secret, recoveryCodes } = await enrol(cookie)

    // Replacing the app: the current factor authorises it...
    clock.advance(60_000)
    const replacing = await app.inject({
      method: 'POST',
      url: '/api/totp',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(secret, totpStep(clock.now().getTime())),
      },
    })
    expect(replacing.statusCode).toBe(200)
    const next = replacing.json().secret as string
    clock.advance(60_000)
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/totp/confirm',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(next, totpStep(clock.now().getTime())),
      },
    })
    expect(confirmed.statusCode).toBe(200)

    // ...and there is one set of codes afterwards, not two.
    const rows = await pg.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM admin_recovery_codes',
    )
    expect(rows.rows[0]?.n).toBe(10)
    const old = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: recoveryCodes[0] as string,
    })
    expect(old.statusCode).toBe(401)
    const issued = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      recoveryCode: (confirmed.json().recoveryCodes as string[])[0] as string,
    })
    expect(issued.statusCode).toBe(200)
  })

  it('refuses a code and a recovery code in one request', async () => {
    const cookie = await signedIn(app, pg)
    const { secret, recoveryCodes } = await enrol(cookie)
    const r = await signInWith({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      code: totpCode(secret, totpStep(clock.now().getTime())),
      recoveryCode: recoveryCodes[0],
    })
    expect(r.statusCode).toBe(400)
  })

  it('takes the codes with it when it is turned off', async () => {
    const cookie = await signedIn(app, pg)
    const { secret } = await enrol(cookie)
    clock.advance(60_000)
    const off = await app.inject({
      method: 'DELETE',
      url: '/api/totp',
      headers: write(cookie),
      payload: {
        password: ADMIN_PASSWORD,
        code: totpCode(secret, totpStep(clock.now().getTime())),
      },
    })
    expect(off.statusCode).toBe(200)
    expect((await pg.query('SELECT 1 FROM admin_recovery_codes')).rowCount).toBe(0)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: read(cookie) })
    expect(me.json().totpEnabled).toBe(false)
    expect((await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).statusCode).toBe(
      200,
    )
  })
})

describe('changing the password', () => {
  it('needs the current one, and signs every other session out', async () => {
    const first = await signedIn(app, pg)
    const secondLogin = await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    const second = cookieFrom(secondLogin.headers['set-cookie'])

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(first),
      payload: { currentPassword: 'not the password', newPassword: 'a new decent password' },
    })
    expect(wrong.statusCode).toBe(403)

    const changed = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(first),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'a new decent password' },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().otherSessionsSignedOut).toBe(1)
    // The session that changed it keeps working; the other one does not.
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: read(first) })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: read(second) })).statusCode,
    ).toBe(401)
    // And the old password no longer signs in.
    expect((await signInWith({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).statusCode).toBe(
      401,
    )
    expect(
      (await signInWith({ email: ADMIN_EMAIL, password: 'a new decent password' })).statusCode,
    ).toBe(200)
  })

  it('refuses a new password shorter than the floor', async () => {
    const cookie = await signedIn(app, pg)
    const r = await app.inject({
      method: 'POST',
      url: '/api/password',
      headers: write(cookie),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'short' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_body')
  })
})

describe('signing in as a function', () => {
  it('refuses while no account exists, and never throws', async () => {
    await expect(
      signIn(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, clock.now()),
    ).resolves.toEqual({ ok: false, reason: 'no_admin' })
  })
})
