/**
 * The one admin account: reading it, creating it, changing its password, and
 * the sign-in that checks all three factors it may have.
 *
 * Every read and write of it goes through here, including the CLI's
 * `admin create` and `admin passwd`, so there is one place that knows how a
 * password is stored — recovery codes included, which are stored the same way
 * and for the same reason — and one place that decides what a failed attempt
 * costs.
 *
 * A sign-in runs inside a transaction that takes the account row with
 * `FOR UPDATE`. That is deliberate: it serialises attempts, so the failure
 * count and the lockout are exact rather than approximately right under
 * concurrency, a one-time code cannot be spent twice by two requests that read
 * the same `totp_last_step`, and a recovery code cannot be used twice. The
 * cost — attempts queue behind each other — is the behaviour wanted from a
 * guessing gate, and the per-address limiter and the concurrency gate in front
 * of it are what stop that queue from growing.
 */
import { randomBytes } from 'node:crypto'
import {
  ADMIN_SCRYPT,
  type NewApiKey,
  hashPassword,
  newRecoveryCodes,
  newTotpSecret,
  normaliseRecoveryCode,
  passwordFingerprint,
  verifyPassword,
  verifyTotp,
} from '@clickmonk/core'
import type { Pool, PoolClient } from '@clickmonk/db'

export interface AdminAccount {
  email: string
  passwordHash: string
  /** Null: not enrolled in two-factor authentication. */
  totpSecret: string | null
  totpLastStep: number
  failedLogins: number
  /** When the last of those failures was, or null if there have been none. */
  lastFailedAt: Date | null
  lockedUntil: Date | null
}

interface AccountRow {
  email: string
  password_hash: string
  totp_secret: string | null
  totp_last_step: string
  failed_logins: number
  last_failed_at: Date | null
  locked_until: Date | null
}

const toAccount = (r: AccountRow): AdminAccount => ({
  email: r.email,
  passwordHash: r.password_hash,
  totpSecret: r.totp_secret,
  totpLastStep: Number(r.totp_last_step),
  failedLogins: r.failed_logins,
  lastFailedAt: r.last_failed_at,
  lockedUntil: r.locked_until,
})

const SELECT_ACCOUNT = `SELECT email, password_hash, totp_secret, totp_last_step,
                               failed_logins, last_failed_at, locked_until FROM admin_account`

export async function loadAccount(pg: Pool): Promise<AdminAccount | null> {
  const r = await pg.query<AccountRow>(SELECT_ACCOUNT)
  const row = r.rows[0]
  return row ? toAccount(row) : null
}

/** Lower-cased and trimmed: the column requires it, and a sign-in compares against it. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export class AccountExistsError extends Error {
  constructor() {
    super('this install already has an admin account')
    this.name = 'AccountExistsError'
  }
}

/**
 * Creates the account. One install, one admin: a second call throws rather
 * than replacing the first, so a script run twice cannot take an install over.
 */
export async function createAccount(
  pg: Pool,
  o: { email: string; password: string },
): Promise<void> {
  const hash = await hashPassword(o.password, ADMIN_SCRYPT)
  const r = await pg.query(
    `INSERT INTO admin_account (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [normaliseEmail(o.email), hash],
  )
  if ((r.rowCount ?? 0) === 0) throw new AccountExistsError()
}

/**
 * Replaces the password. Returns the new stored hash, whose fingerprint is
 * what every proof issued under the old password was bound to.
 *
 * `clearLockout` is required, and it decides whether the failure count, its
 * clock and any standing lockout go with the password. A caller has to say,
 * because the two callers are answering different questions and neither answer
 * is a default. The command line clears: it is the way back in for an admin
 * locked out at the form, who can then set a new password and use it at once
 * rather than waiting out a lock whose only purpose was to protect the
 * password they have just replaced, and a shell on the host is already an
 * authority nothing here can bound. The route does not: it needs a session and
 * the current password and no second factor, and that count is the only bound
 * on guesses at the second factor behind a session — clearing it there would
 * make a password change the way to reset the ladder between guesses and never
 * reach the lock. It is the same argument `disableTotp` makes one factor along.
 */
export async function setAccountPassword(
  pg: Pool,
  password: string,
  o: { clearLockout: boolean },
): Promise<string> {
  const hash = await hashPassword(password, ADMIN_SCRYPT)
  const r = await pg.query(
    `UPDATE admin_account SET password_hash = $1, updated_at = now()${
      o.clearLockout
        ? `,
                              failed_logins = 0, last_failed_at = NULL, locked_until = NULL`
        : ''
    }`,
    [hash],
  )
  if ((r.rowCount ?? 0) === 0) throw new Error('this install has no admin account yet')
  return hash
}

/** Failures before the account locks, and how long each further one adds. */
export const LOCKOUT_AFTER = 5
const LOCKOUT_STEP_MS = 5 * 60 * 1000
export const LOCKOUT_MAX_MS = 60 * 60 * 1000

/** Five failures lock for five minutes, six for ten, and so on to an hour. */
export function lockoutMs(failedLogins: number): number {
  if (failedLogins < LOCKOUT_AFTER) return 0
  return Math.min((failedLogins - LOCKOUT_AFTER + 1) * LOCKOUT_STEP_MS, LOCKOUT_MAX_MS)
}

/**
 * How long a quiet account waits before its failures are forgotten: the longest
 * lockout, measured from the last failure.
 *
 * Without a decay the count is permanent, and four typos spread over a year —
 * each one immediately followed by the right password — lock the admin out on
 * the fifth, with nothing surfacing the count and a lock that refuses the
 * sign-in that would clear it. Forgetting costs an attacker almost nothing:
 * they were already held to a handful of guesses per lockout and the lockout
 * already grows to an hour, so what this concedes — a few guesses an hour,
 * indefinitely — is the bound the lockout had already chosen.
 */
export const FAILED_DECAY_MS = LOCKOUT_MAX_MS

/**
 * The failures this attempt counts on top of: the stored count, unless the last
 * failure is older than `FAILED_DECAY_MS`, in which case the run has lapsed and
 * this attempt starts from zero.
 *
 * Read on both doors — the sign-in form and the password check behind a session
 * — because the second is the one that strands a count: it is where a typo is
 * followed immediately by the right password, so the failure is recorded and
 * nothing ever clears it.
 */
export function activeFailures(
  account: Pick<AdminAccount, 'failedLogins' | 'lastFailedAt'>,
  now: Date,
): number {
  if (!account.lastFailedAt) return 0
  return now.getTime() - account.lastFailedAt.getTime() >= FAILED_DECAY_MS
    ? 0
    : account.failedLogins
}

export type SignInRefusal =
  | { ok: false; reason: 'no_admin' }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'totp_required' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }

export type SignInResult = { ok: true; email: string } | SignInRefusal

export interface SignInInput {
  email: string
  password: string
  /** A code from the authenticator app, when the account is enrolled. */
  code?: string | undefined
  /** Or one recovery code, used once. */
  recoveryCode?: string | undefined
}

/**
 * A hash no password matches, used when the address is wrong so that a wrong
 * address costs exactly what a wrong password costs. Built once, from a value
 * nobody knows, rather than committed as a literal: a hash-shaped constant in
 * the repository reads like a credential to everyone who finds it.
 *
 * At `ADMIN_SCRYPT`, which is the whole point — it stands in for the admin's
 * stored hash, and a dummy at any other cost would make a wrong address
 * measurably cheaper than a wrong password and reopen the leak it closes.
 */
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(
    `no-such-password-${randomBytes(32).toString('hex')}`,
    ADMIN_SCRYPT,
  )
  return dummyHashPromise
}

/**
 * Finds the one unused recovery code this value matches and spends it.
 *
 * A recovery code is stored at `ADMIN_SCRYPT` with its own salt, so there is
 * nothing to look it up by: every unused row has to be verified against. There
 * are at most `RECOVERY_CODE_COUNT` of them, so a wrong code costs ten scrypt
 * passes and a right one costs five on average — measured at roughly a second
 * for the ten on a small VM. Affordable only because this runs behind the
 * per-account attempt counter, the account lockout and the concurrency gate,
 * and at most once in a code's life. It does mean a recovery sign-in holds its
 * concurrency slot for about that long, which is the bound to revisit if
 * `RECOVERY_CODE_COUNT` ever grows.
 *
 * The caller's transaction already holds the account row `FOR UPDATE`, so two
 * requests cannot spend the same code; the `used_at IS NULL` in the update is
 * the second lock, for a caller that ever forgets the first. Those two filters
 * are each other's understudy, which is why no test can separate them: with
 * either one in place a spent code is refused, and only removing both lets one
 * be spent twice. Keep both, and read "a code is spent once" as the property
 * they hold between them rather than as either line's own.
 */
async function spendRecoveryCode(
  client: PoolClient,
  normalised: string,
  now: Date,
): Promise<boolean> {
  const rows = await client.query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM admin_recovery_codes
      WHERE used_at IS NULL ORDER BY created_at, id`,
  )
  for (const row of rows.rows) {
    if (!(await verifyPassword(normalised, row.code_hash))) continue
    const spent = await client.query(
      'UPDATE admin_recovery_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL',
      [row.id, now],
    )
    return (spent.rowCount ?? 0) > 0
  }
  return false
}

/**
 * Verifies and spends whichever second factor was presented, inside a
 * transaction that already holds the account row. One place, so the code path
 * and the recovery-code path cannot drift apart in what "spent" means: both are
 * one-time, and both are consumed by the act of checking them.
 */
async function spendSecondFactor(
  client: PoolClient,
  account: AdminAccount,
  o: { code?: string | undefined; recoveryCode?: string | undefined; now: Date },
): Promise<boolean> {
  if (o.recoveryCode !== undefined) {
    const normalised = normaliseRecoveryCode(o.recoveryCode)
    // The same helper the sign-in uses, for the same reason: one place knows
    // how a recovery code is stored and how it is spent.
    return normalised !== null && (await spendRecoveryCode(client, normalised, o.now))
  }
  if (o.code === undefined) return false
  const check = verifyTotp({
    secret: account.totpSecret as string,
    code: o.code,
    atMs: o.now.getTime(),
    lastStep: account.totpLastStep,
  })
  if (!check) return false
  // The step is recorded so this code cannot be used again.
  await client.query('UPDATE admin_account SET totp_last_step = $1, updated_at = $2', [
    check.step,
    o.now,
  ])
  return true
}

/**
 * Records one wrong credential on top of the failures that are still current,
 * and stamps the clock the decay is measured from. `locked_until` stays a wall
 * clock rather than an elapsed count: it has to survive a restart, and a
 * process that forgot its lockouts every deploy would be no lockout at all.
 */
async function recordFailure(client: PoolClient, failures: number, now: Date): Promise<void> {
  const failed = failures + 1
  const lock = lockoutMs(failed)
  await client.query(
    `UPDATE admin_account SET failed_logins = $1, last_failed_at = $3,
                              locked_until = $2, updated_at = $3`,
    [failed, lock > 0 ? new Date(now.getTime() + lock) : null, now],
  )
}

/**
 * Checks an attempt and records what it cost. Every refusal but `locked` and
 * `totp_required` reads the same to the caller — `invalid` — so nothing here
 * says whether it was the address, the password or the code that was wrong.
 */
export async function signIn(pg: Pool, input: SignInInput, now: Date): Promise<SignInResult> {
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const r = await client.query<AccountRow>(`${SELECT_ACCOUNT} FOR UPDATE`)
    const row = r.rows[0]
    if (!row) {
      // A full scrypt pass against a throwaway hash, exactly as a wrong address
      // costs below. An install nobody has claimed yet must not be cheaper to
      // probe than one that is, and the route answers it as a wrong password:
      // the sign-in form is anonymous, so anything it says about whether the
      // account exists is said to whoever asks.
      await verifyPassword(input.password, await dummyHash())
      await client.query('COMMIT')
      return { ok: false, reason: 'no_admin' }
    }
    const account = toAccount(row)
    if (account.lockedUntil && account.lockedUntil.getTime() > now.getTime()) {
      await client.query('COMMIT')
      return {
        ok: false,
        reason: 'locked',
        retryAfterSeconds: Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 1000),
      }
    }
    // Failures older than `FAILED_DECAY_MS` have lapsed: a typo last quarter
    // must not be half of a lockout today.
    const failures = activeFailures(account, now)
    const emailOk = normaliseEmail(input.email) === account.email
    // Always a real scrypt pass, against this account's hash or a throwaway
    // one, so the time taken says nothing about whether the address was right.
    const passwordOk = await verifyPassword(
      input.password,
      emailOk ? account.passwordHash : await dummyHash(),
    )
    if (!emailOk || !passwordOk) {
      await recordFailure(client, failures, now)
      await client.query('COMMIT')
      return { ok: false, reason: 'invalid' }
    }

    if (account.totpSecret !== null) {
      if (input.recoveryCode !== undefined) {
        const normalised = normaliseRecoveryCode(input.recoveryCode)
        // Nothing to look the code up by: `spendRecoveryCode` reads the unused
        // rows and verifies against each, inside the transaction that already
        // holds the account row, then spends the one that matched.
        const spent = normalised !== null && (await spendRecoveryCode(client, normalised, now))
        if (!spent) {
          await recordFailure(client, failures, now)
          await client.query('COMMIT')
          return { ok: false, reason: 'invalid' }
        }
      } else if (input.code !== undefined) {
        const check = verifyTotp({
          secret: account.totpSecret,
          code: input.code,
          atMs: now.getTime(),
          lastStep: account.totpLastStep,
        })
        if (!check) {
          await recordFailure(client, failures, now)
          await client.query('COMMIT')
          return { ok: false, reason: 'invalid' }
        }
        // The step is recorded so this code cannot be used again.
        await client.query('UPDATE admin_account SET totp_last_step = $1, updated_at = $2', [
          check.step,
          now,
        ])
      } else {
        // The password was right and a code is needed. Not counted against
        // the account: it is an incomplete attempt, not a wrong credential.
        // The per-address limiter still counts it.
        await client.query('COMMIT')
        return { ok: false, reason: 'totp_required' }
      }
    }

    await client.query(
      `UPDATE admin_account SET failed_logins = 0, last_failed_at = NULL,
                                locked_until = NULL, updated_at = $1`,
      [now],
    )
    await client.query('COMMIT')
    return { ok: true, email: account.email }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Every password check that is not a sign-in: `POST /api/password` and the
 * TOTP routes all come through here.
 *
 * It runs in the same `FOR UPDATE` transaction a sign-in does, and it counts
 * and honours the same lockout, because a session cookie is not a bound. A
 * stolen cookie would otherwise be an unbounded oracle on the current password
 * at whatever rate the concurrency gate allows — which is the one thing the
 * lockout exists to stop, arrived at through a different door.
 *
 * It does **not** clear the count on success, and a sign-in does. A password
 * check is half a credential: it is the first step of a request that still has
 * its second factor to prove, so clearing here would let a caller who knows the
 * password reset the count between guesses at the code and never reach the
 * lockout at all. The count is cleared by a complete sign-in, which is the only
 * thing that shows every factor the account has.
 */
export async function checkAccountPassword(
  pg: Pool,
  password: string,
  now: Date,
): Promise<SignInRefusal | { ok: true }> {
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const r = await client.query<AccountRow>(`${SELECT_ACCOUNT} FOR UPDATE`)
    const row = r.rows[0]
    if (!row) {
      await client.query('COMMIT')
      return { ok: false, reason: 'no_admin' }
    }
    const account = toAccount(row)
    if (account.lockedUntil && account.lockedUntil.getTime() > now.getTime()) {
      await client.query('COMMIT')
      return {
        ok: false,
        reason: 'locked',
        retryAfterSeconds: Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 1000),
      }
    }
    if (!(await verifyPassword(password, account.passwordHash))) {
      await recordFailure(client, activeFailures(account, now), now)
      await client.query('COMMIT')
      return { ok: false, reason: 'invalid' }
    }
    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Spends one second factor against the account as it stands now: a code from
 * the authenticator currently enrolled, or an unused recovery code. Same
 * transaction, so a code is spent exactly once here as it is at a sign-in.
 *
 * **A wrong code costs the account exactly what a wrong password costs**, and
 * the lockout it earns is honoured here too. Without that, a caller holding a
 * session and the password had an unbounded oracle on the second factor: the
 * password check in front of this one succeeds every time, so nothing was
 * counted and nothing ever locked, and a six-digit code is a million guesses
 * whatever the authenticator app holds. It is the same argument that puts a
 * password check behind a session under the lockout, one factor along.
 *
 * `invalid` when the account is not enrolled at all, because then there is no
 * second factor to spend and the caller must not treat "nothing to check" as
 * "checked" — and that case records nothing, since there was no credential to
 * get wrong.
 */
export async function useSecondFactor(
  pg: Pool,
  o: { code?: string | undefined; recoveryCode?: string | undefined; now: Date },
): Promise<SignInRefusal | { ok: true }> {
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const r = await client.query<AccountRow>(`${SELECT_ACCOUNT} FOR UPDATE`)
    const row = r.rows[0]
    if (!row) {
      await client.query('COMMIT')
      return { ok: false, reason: 'no_admin' }
    }
    if (row.totp_secret === null) {
      await client.query('COMMIT')
      return { ok: false, reason: 'invalid' }
    }
    const account = toAccount(row)
    if (account.lockedUntil && account.lockedUntil.getTime() > o.now.getTime()) {
      await client.query('COMMIT')
      return {
        ok: false,
        reason: 'locked',
        retryAfterSeconds: Math.ceil((account.lockedUntil.getTime() - o.now.getTime()) / 1000),
      }
    }
    const spent = await spendSecondFactor(client, account, o)
    if (!spent) {
      await recordFailure(client, activeFailures(account, o.now), o.now)
      await client.query('COMMIT')
      return { ok: false, reason: 'invalid' }
    }
    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** How long an enrolment the admin started stays confirmable. */
export const TOTP_PENDING_MS = 15 * 60 * 1000

/**
 * Enrolment, step one: mint a secret **on the server** and keep it on the
 * account row until a code proves the authenticator app has it. The secret is
 * never taken from a request, so there is no field a caller can set to decide
 * which secret gets enrolled — and an enrolment the admin abandoned is
 * replaced by the next one rather than left usable forever.
 */
export async function startTotpEnrolment(pg: Pool, now: Date): Promise<string> {
  const secret = newTotpSecret()
  const r = await pg.query(
    'UPDATE admin_account SET totp_pending_secret = $1, totp_pending_at = $2, updated_at = $2',
    [secret, now],
  )
  if ((r.rowCount ?? 0) === 0) throw new Error('this install has no admin account yet')
  return secret
}

/** The pending secret, or null when there is none or it has gone stale. */
export async function pendingTotpSecret(pg: Pool, now: Date): Promise<string | null> {
  const r = await pg.query<{ totp_pending_secret: string | null; totp_pending_at: Date | null }>(
    'SELECT totp_pending_secret, totp_pending_at FROM admin_account',
  )
  const row = r.rows[0]
  if (!row?.totp_pending_secret || !row.totp_pending_at) return null
  return row.totp_pending_at.getTime() + TOTP_PENDING_MS > now.getTime()
    ? row.totp_pending_secret
    : null
}

export interface TotpEnrolled {
  /** Shown once. Only hashes are stored, at `ADMIN_SCRYPT`. */
  recoveryCodes: string[]
}

/**
 * Hashes a fresh set of recovery codes, at the cost a password is stored at.
 *
 * Deliberately not inside a transaction: ten scrypt passes at 32 MiB is the
 * best part of a second, and holding the account row `FOR UPDATE` for that
 * long would make every concurrent sign-in queue behind an enrolment. The
 * codes are minted and hashed first; the transaction only writes rows.
 */
async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  const hashes: string[] = []
  for (const code of codes) {
    hashes.push(await hashPassword(normaliseRecoveryCode(code) as string, ADMIN_SCRYPT))
  }
  return hashes
}

/**
 * Turns two-factor authentication on, once a code proves the secret reached
 * the authenticator app, and issues a fresh set of recovery codes. Every
 * previous code is deleted in the same transaction: a set of codes belongs to
 * one secret, and leaving the old ones would keep a way in that the admin
 * believes they replaced.
 */
export async function enrolTotp(
  pg: Pool,
  o: { secret: string; code: string; now: Date },
): Promise<TotpEnrolled | null> {
  const check = verifyTotp({
    secret: o.secret,
    code: o.code,
    atMs: o.now.getTime(),
    lastStep: null,
  })
  if (!check) return null
  const codes = newRecoveryCodes()
  const hashes = await hashRecoveryCodes(codes)
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    // The pending secret becomes the live one and is cleared in the same
    // statement, so a confirmed enrolment cannot be confirmed twice.
    const r = await client.query(
      `UPDATE admin_account SET totp_secret = $1, totp_last_step = $2, updated_at = $3,
                                totp_pending_secret = NULL, totp_pending_at = NULL`,
      [o.secret, check.step, o.now],
    )
    if ((r.rowCount ?? 0) === 0) throw new Error('this install has no admin account yet')
    await client.query('DELETE FROM admin_recovery_codes')
    for (const hash of hashes) {
      await client.query(
        'INSERT INTO admin_recovery_codes (code_hash, created_at) VALUES ($1, $2)',
        [hash, o.now],
      )
    }
    await client.query('COMMIT')
    return { recoveryCodes: codes }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Turns it off, and deletes the recovery codes with it.
 *
 * `clearLockout` is required, and it decides whether the failure count, its
 * clock and any standing lockout go too. A caller has to say, because the two
 * callers are answering different questions and neither answer is a default.
 * The route that removes the factor has just been shown the factor, so it
 * changes nothing about the counters; the command that removes it from the
 * server is a way back in for an operator who has lost the factor, and the
 * failures that earned any standing lockout were guesses at the very thing
 * being removed — leaving that lock over a factor that no longer exists would
 * hold the only account out for nothing, which is the same argument
 * `setAccountPassword` makes one credential along.
 */
export async function disableTotp(
  pg: Pool,
  now: Date,
  o: { clearLockout: boolean },
): Promise<void> {
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE admin_account SET totp_secret = NULL, totp_last_step = 0, updated_at = $1,
                                totp_pending_secret = NULL, totp_pending_at = NULL${
                                  o.clearLockout
                                    ? `,
                                failed_logins = 0, last_failed_at = NULL, locked_until = NULL`
                                    : ''
                                }`,
      [now],
    )
    await client.query('DELETE FROM admin_recovery_codes')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Replaces the recovery codes and returns the new ones. */
export async function regenerateRecoveryCodes(pg: Pool, now: Date): Promise<string[]> {
  const codes = newRecoveryCodes()
  const hashes = await hashRecoveryCodes(codes)
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM admin_recovery_codes')
    for (const hash of hashes) {
      await client.query(
        'INSERT INTO admin_recovery_codes (code_hash, created_at) VALUES ($1, $2)',
        [hash, now],
      )
    }
    await client.query('COMMIT')
    return codes
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function unusedRecoveryCodeCount(pg: Pool): Promise<number> {
  const r = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM admin_recovery_codes WHERE used_at IS NULL',
  )
  return r.rows[0]?.n ?? 0
}

/** Re-exported so callers that only import this module can mint a key's halves. */
export type { NewApiKey }
export { passwordFingerprint }
