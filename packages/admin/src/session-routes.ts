import { MAX_PASSWORD_LENGTH, MIN_ADMIN_PASSWORD_LENGTH, totpUri } from '@clickmonk/core'
import { rateKey } from '@clickmonk/ipdata'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  activeFailures,
  checkAccountPassword,
  disableTotp,
  enrolTotp,
  loadAccount,
  pendingTotpSecret,
  regenerateRecoveryCodes,
  setAccountPassword,
  signIn,
  startTotpEnrolment,
  unusedRecoveryCodeCount,
  useSecondFactor,
} from './account.js'
import type { AdminContext } from './app.js'
import { clientAddress } from './app.js'
import {
  CLEARED_SESSION_COOKIE,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  createSession,
  deleteExpiredSessions,
  requireCredential,
  requireSession,
  sessionCookie,
} from './auth.js'
import { fail, readBody } from './http.js'

const Password = z.string().min(MIN_ADMIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH)

const SignInBody = z
  .object({
    email: z.string().min(3).max(320),
    // Not the password rules: a sign-in must accept whatever is stored, even
    // if the floor was raised since, and must not answer differently for a
    // password that is merely too short.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    code: z.string().max(16).optional(),
    recoveryCode: z.string().max(32).optional(),
  })
  .strict()

const PasswordChangeBody = z
  .object({ currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH), newPassword: Password })
  .strict()

/**
 * Confirming an enrolment. There is no `secret` field: the secret is the one
 * `POST /api/totp` minted and stored, so no request can decide which secret
 * gets enrolled.
 */
const ConfirmBody = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    code: z.string().max(16),
  })
  .strict()

/**
 * The password plus, when a second factor is already enrolled, that factor.
 * Used by the two routes that would otherwise let a session and a password
 * replace or remove the second factor between them.
 */
const SecondFactorBody = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    code: z.string().max(16).optional(),
    recoveryCode: z.string().max(32).optional(),
  })
  .strict()

/**
 * Checks the password of the admin who is already signed in, for an action
 * that changes how signing in works. A session cookie alone is not enough for
 * those: a session left open on a shared machine must not be able to enrol a
 * new authenticator or turn the second factor off.
 *
 * Bounded exactly as a sign-in is, and for the same reason: a stolen cookie is
 * not a bound. The attempt counter is keyed by the account rather than by the
 * address — there is one account, and what is being guessed is its password,
 * not a route — and the account's own lockout is honoured and extended, so
 * five wrong guesses here lock the account just as five at the sign-in form
 * would. Without this a cookie taken off a shared machine is an oracle that
 * runs at whatever rate the concurrency gate allows, forever.
 */
const PASSWORD_CONFIRM_KEY = 'account'

async function confirmPassword(ctx: AdminContext, password: string): Promise<void> {
  const now = ctx.now()
  // The counter runs on the monotonic clock; `now` is what reaches the row.
  const tick = ctx.monotonic()
  const attempt = ctx.loginAttempts.check(PASSWORD_CONFIRM_KEY, tick)
  if (!attempt.allowed) {
    fail(429, 'too_many_attempts', 'too many password checks; wait and try again', {
      'retry-after': String(Math.ceil(attempt.retryAfterMs / 1000)),
    })
  }
  if (!ctx.passwordGate.tryEnter()) {
    fail(503, 'busy', 'too many password checks at once; try again', { 'retry-after': '1' })
  }
  let result: Awaited<ReturnType<typeof checkAccountPassword>>
  try {
    result = await checkAccountPassword(ctx.pg, password, now)
  } finally {
    ctx.passwordGate.leave()
  }
  if (result.ok) {
    ctx.loginAttempts.succeed(PASSWORD_CONFIRM_KEY)
    return
  }
  ctx.loginAttempts.fail(PASSWORD_CONFIRM_KEY, tick)
  if (result.reason === 'no_admin') {
    fail(503, 'no_admin', 'this install has no admin account yet')
  }
  if (result.reason === 'locked') {
    fail(429, 'locked', 'too many failed attempts; this account is locked for a while', {
      'retry-after': String(result.retryAfterSeconds),
    })
  }
  fail(403, 'invalid_password', 'that is not the current password')
}

/**
 * The second factor a change to the second factor needs. Only asked of an
 * account that has one — the first enrolment cannot produce a code for a
 * secret it does not have yet — and it spends the code or the recovery code it
 * was given, so neither can be replayed.
 */
async function confirmSecondFactor(
  ctx: AdminContext,
  body: { code?: string | undefined; recoveryCode?: string | undefined },
): Promise<void> {
  const account = await loadAccount(ctx.pg)
  if (!account || account.totpSecret === null) return
  if (body.code !== undefined && body.recoveryCode !== undefined) {
    fail(400, 'invalid_body', 'send a code or a recovery code, not both')
  }
  if (body.code === undefined && body.recoveryCode === undefined) {
    fail(
      403,
      'totp_required',
      'changing or removing the authenticator app needs a code from it, or a recovery code',
    )
  }
  const used = await useSecondFactor(ctx.pg, {
    code: body.code,
    recoveryCode: body.recoveryCode,
    now: ctx.now(),
  })
  if (used.ok) return
  // A wrong code counts against the account and can lock it, exactly as a wrong
  // password does, so this answers the lockout rather than swallowing it.
  if (used.reason === 'locked') {
    fail(429, 'locked', 'too many failed attempts; this account is locked for a while', {
      'retry-after': String(used.retryAfterSeconds),
    })
  }
  fail(403, 'invalid_code', 'that code does not match this account')
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AdminContext): void {
  /**
   * Signing in. Three gates in front of the password check: the per-address
   * limiter, the account's own lockout, and the bound on password checks in
   * flight. Every refusal but a lockout answers 401 with the same body, so
   * nothing here says whether the address exists or the password was right.
   */
  app.post('/api/session', async (req, reply) => {
    const body = readBody(SignInBody, req.body)
    if (body.code !== undefined && body.recoveryCode !== undefined) {
      fail(400, 'invalid_body', 'send a code or a recovery code, not both')
    }
    const now = ctx.now()
    const tick = ctx.monotonic()
    const address = clientAddress(req)
    // The limiter counts per /64 for IPv6, for the reason `rateKey` states: a
    // client usually holds a whole /64 and can pick a new address from it for
    // every request, so ten failures per address is no bound at all for one —
    // at the form where the password being guessed owns the install. Taken here
    // rather than inside `clientAddress`, because `address` is also what the
    // session row records and what the admin reads back in their session list.
    // An address the parser cannot read keys on itself.
    const key = rateKey(address) ?? address
    const attempt = ctx.loginAttempts.check(key, tick)
    if (!attempt.allowed) {
      fail(429, 'too_many_attempts', 'too many sign-in attempts; wait and try again', {
        'retry-after': String(Math.ceil(attempt.retryAfterMs / 1000)),
      })
    }
    if (!ctx.passwordGate.tryEnter()) {
      fail(503, 'busy', 'too many password checks at once; try again', { 'retry-after': '1' })
    }
    let result: Awaited<ReturnType<typeof signIn>>
    try {
      result = await signIn(
        ctx.pg,
        {
          email: body.email,
          password: body.password,
          code: body.code,
          recoveryCode: body.recoveryCode,
        },
        now,
      )
    } finally {
      ctx.passwordGate.leave()
    }
    if (!result.ok) {
      ctx.loginAttempts.fail(key, tick)
      // `no_admin` is deliberately not answered here. This route is anonymous
      // and Caddy serves it to the whole internet on the admin host, so saying
      // "this install has no admin account yet" tells a stranger the account is
      // still unclaimed — the one thing `/health` is careful not to say. It
      // reads as a wrong password instead, and costs the same: `signIn` runs a
      // full scrypt pass against a throwaway hash when there is no account.
      // Whoever is setting the install up is at the CLI, not at this form.
      if (result.reason === 'locked') {
        return fail(429, 'locked', 'too many failed attempts; this account is locked for a while', {
          'retry-after': String(result.retryAfterSeconds),
        })
      }
      if (result.reason === 'totp_required') {
        return fail(401, 'totp_required', 'send the six-digit code from your authenticator app')
      }
      return fail(401, 'invalid_credentials', 'that email and password do not match')
    }
    ctx.loginAttempts.succeed(key)
    const session = await createSession(ctx.pg, {
      now,
      userAgent: String(req.headers['user-agent'] ?? ''),
      ip: address,
    })
    // Cheap, bounded, and only after a successful sign-in, so nobody
    // unauthenticated can make this run.
    await deleteExpiredSessions(ctx.pg, now)
    return reply
      .header('set-cookie', sessionCookie(session.token, Math.floor(SESSION_ABSOLUTE_MS / 1000)))
      .send({ ok: true, expiresAt: session.expiresAt.toISOString() })
  })

  /** Signs this browser out, and clears the cookie whether the row was there or not. */
  app.delete('/api/session', async (req, reply) => {
    const credential = requireSession(req)
    await ctx.pg.query('DELETE FROM sessions WHERE id = $1', [credential.id])
    return reply.header('set-cookie', CLEARED_SESSION_COOKIE).send({ ok: true })
  })

  app.get('/api/sessions', async (req) => {
    const credential = requireSession(req)
    // The same two bounds `deleteExpiredSessions` deletes on. The sweep only
    // runs at a sign-in, so between sign-ins this is what stops a session that
    // one of its bounds has already ended from being listed as live.
    const now = ctx.now()
    const r = await ctx.pg.query<{
      id: string
      created_at: Date
      last_seen_at: Date
      expires_at: Date
      user_agent: string
      ip: string
    }>(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip
         FROM sessions WHERE expires_at > $1 AND last_seen_at > $2
         ORDER BY created_at DESC, id LIMIT 200`,
      [now, new Date(now.getTime() - SESSION_IDLE_MS)],
    )
    return {
      sessions: r.rows.map((s) => ({
        id: s.id,
        createdAt: s.created_at.toISOString(),
        lastSeenAt: s.last_seen_at.toISOString(),
        expiresAt: s.expires_at.toISOString(),
        userAgent: s.user_agent,
        ip: s.ip,
        current: s.id === credential.id,
      })),
    }
  })

  /** Signs another browser out. The session list is this install's, so any row may go. */
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    requireSession(req)
    if (!z.string().uuid().safeParse(req.params.id).success) {
      fail(404, 'not_found', 'no such session')
    }
    const r = await ctx.pg.query('DELETE FROM sessions WHERE id = $1', [req.params.id])
    if ((r.rowCount ?? 0) === 0) fail(404, 'not_found', 'no such session')
    return { ok: true }
  })

  app.get('/api/me', async (req) => {
    const credential = requireCredential(req)
    const account = await loadAccount(ctx.pg)
    if (!account) fail(503, 'no_admin', 'this install has no admin account yet')
    const a = account as NonNullable<typeof account>
    const now = ctx.now()
    // The failure count as an attempt right now would read it, and the lockout
    // if one is standing. Nothing else surfaces either, so an admin whose count
    // is creeping up has no way to see it before the lock lands — which is the
    // whole complaint against a count that never decays.
    //
    // To a session only. Those two fields say whether the account is under
    // attack and whether it is locked out right now, which is a running
    // commentary on someone else's sign-ins; a key is a string in a script and
    // has no business reading it. A key holder who wants it can sign in.
    const attempts =
      credential.kind === 'session'
        ? {
            failedLogins: activeFailures(a, now),
            lockedUntil:
              a.lockedUntil && a.lockedUntil.getTime() > now.getTime()
                ? a.lockedUntil.toISOString()
                : null,
          }
        : {}
    return {
      email: a.email,
      totpEnabled: a.totpSecret !== null,
      recoveryCodesLeft: await unusedRecoveryCodeCount(ctx.pg),
      ...attempts,
      credential: credential.kind,
    }
  })

  /**
   * Changing the password. Every other session is signed out in the same
   * request: a password is changed because it may be known, and a session
   * minted under the old one is exactly what an attacker would still hold.
   * Proofs a visitor holds for a link's password are unaffected — they are
   * bound to the link's own hash, not to this one.
   */
  app.post('/api/password', async (req) => {
    const credential = requireSession(req)
    const body = readBody(PasswordChangeBody, req.body)
    await confirmPassword(ctx, body.currentPassword)
    // The failure count and any lockout stay: this route has been shown a
    // session and the current password and never the second factor, and that
    // count is the only bound on guesses at the factor behind a session.
    await setAccountPassword(ctx.pg, body.newPassword, { clearLockout: false })
    const r = await ctx.pg.query('DELETE FROM sessions WHERE id <> $1', [credential.id])
    return { ok: true, otherSessionsSignedOut: r.rowCount ?? 0 }
  })

  /**
   * Enrolment, step one: a secret to put in the authenticator app. It is not
   * stored yet — step two proves the app has it — so an interrupted enrolment
   * leaves the account exactly as it was.
   */
  app.post('/api/totp', async (req) => {
    requireSession(req)
    const body = readBody(SecondFactorBody, req.body)
    await confirmPassword(ctx, body.password)
    // Already enrolled? Then this replaces a working second factor, and the
    // password alone must not be enough to do that — otherwise an attacker
    // holding a session and the password enrols their own authenticator and
    // the second factor was never a factor.
    await confirmSecondFactor(ctx, body)
    const account = await loadAccount(ctx.pg)
    const secret = await startTotpEnrolment(ctx.pg, ctx.now())
    return {
      secret,
      uri: totpUri({
        secret,
        account: account?.email ?? 'admin',
        issuer: ctx.adminHost ?? 'ClickMonk',
      }),
    }
  })

  /** Step two: the code proves the app holds the secret. Returns the recovery codes, once. */
  app.post('/api/totp/confirm', async (req) => {
    requireSession(req)
    const body = readBody(ConfirmBody, req.body)
    await confirmPassword(ctx, body.password)
    // The secret is the one this server minted and stored, never one the body
    // carried: `ConfirmBody` has no `secret` field at all.
    const secret = await pendingTotpSecret(ctx.pg, ctx.now())
    if (!secret) {
      fail(400, 'no_enrolment', 'start an enrolment with POST /api/totp first; it does not wait')
    }
    const enrolled = await enrolTotp(ctx.pg, {
      secret: secret as string,
      code: body.code,
      now: ctx.now(),
    })
    if (!enrolled) fail(400, 'invalid_code', 'that code does not match the secret')
    return { ok: true, recoveryCodes: (enrolled as NonNullable<typeof enrolled>).recoveryCodes }
  })

  app.delete('/api/totp', async (req) => {
    requireSession(req)
    const body = readBody(SecondFactorBody, req.body)
    await confirmPassword(ctx, body.password)
    // Removing the second factor needs the second factor, for the same reason
    // replacing it does: without this, disable-then-enrol is the bypass.
    await confirmSecondFactor(ctx, body)
    // The counters are left alone: this caller has just shown both factors, so
    // there is no lockout to lift that this request has not already passed, and
    // a route is not the place to decide an operator is locked out.
    await disableTotp(ctx.pg, ctx.now(), { clearLockout: false })
    return { ok: true }
  })

  /**
   * A fresh set. Every code printed before this one stops working.
   *
   * The current factor is required, as it is to replace or remove the
   * authenticator app — because this route issues one. A session and the
   * password alone could otherwise mint a set of recovery codes and then spend
   * one of them as the second factor on `DELETE /api/totp`: two requests, and
   * the second factor is gone without the attacker ever holding it.
   */
  app.post('/api/totp/recovery-codes', async (req) => {
    requireSession(req)
    const body = readBody(SecondFactorBody, req.body)
    await confirmPassword(ctx, body.password)
    await confirmSecondFactor(ctx, body)
    const account = await loadAccount(ctx.pg)
    if (!account || account.totpSecret === null) {
      fail(400, 'totp_not_enabled', 'recovery codes are for an account with an authenticator app')
    }
    return { recoveryCodes: await regenerateRecoveryCodes(ctx.pg, ctx.now()) }
  })
}
