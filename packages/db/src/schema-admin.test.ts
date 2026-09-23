import { ADMIN_SCRYPT, LINK_SCRYPT, SCRYPT_PREFIX, hashPassword } from '@clickmonk/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabases, testCh, testPg } from './testing.js'

const pool = testPg()
const ch = testCh()

let goodHash = ''

beforeAll(async () => {
  await resetDatabases(pool, ch)
  // Derived here, never a literal: a hash-shaped constant in this repository
  // reads like a credential to everyone who finds it.
  goodHash = await hashPassword('a decent admin password', ADMIN_SCRYPT)
})

beforeEach(async () => {
  await pool.query('TRUNCATE admin_account, admin_recovery_codes, sessions, api_keys')
  await pool.query('TRUNCATE domains CASCADE')
})

afterAll(async () => {
  await pool.end()
  await ch.close()
})

const insertAdmin = (email = 'admin@example.com', hash = goodHash) =>
  pool.query('INSERT INTO admin_account (email, password_hash) VALUES ($1, $2)', [email, hash])

/** A frame built from the prefix, so no `scrypt$…` literal is committed. */
const frame = (rest: string): string => `${SCRYPT_PREFIX}$${rest}`

describe('postgres schema 006: the admin account', () => {
  it('stores one account, unenrolled and unlocked', async () => {
    await insertAdmin()
    const r = await pool.query(
      'SELECT email, totp_secret, totp_last_step, failed_logins, locked_until FROM admin_account',
    )
    expect(r.rows).toEqual([
      {
        email: 'admin@example.com',
        totp_secret: null,
        totp_last_step: '0',
        failed_logins: 0,
        locked_until: null,
      },
    ])
  })

  it('refuses a second account', async () => {
    await insertAdmin()
    // The primary key is the reason there can only be one, and `id` may only
    // be true, so both ways of trying fail for a named reason.
    await expect(insertAdmin('other@example.com')).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    )
    await expect(
      pool.query('INSERT INTO admin_account (id, email, password_hash) VALUES (false, $1, $2)', [
        'other@example.com',
        goodHash,
      ]),
    ).rejects.toThrow(/violates check constraint/)
  })

  it.each([
    ['an upper-case address', 'Admin@example.com'],
    ['no at sign', 'adminexample.com'],
    ['an address that starts with the at sign', '@example.com'],
    ['an empty address', ''],
  ])('refuses %s', async (_label, email) => {
    await expect(insertAdmin(email)).rejects.toThrow(/violates check constraint/)
  })

  // The column that stops a plain password from being stored, in the table
  // that would be read in every backup and every replica.
  it.each([
    ['a plain password', 'correct horse battery'],
    ['an empty hash', ''],
    ['another algorithm', 'argon2$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2g'],
    ['no parameters', frame('c2FsdHNhbHQ$aGFzaGhhc2g')],
    ['a salt that is too short', frame('16384$8$1$c2E$aGFzaGhhc2g')],
    ['a hash with a character outside base64url', frame('16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2g=')],
  ])('refuses %s as the password hash', async (_label, hash) => {
    await expect(insertAdmin('admin@example.com', hash)).rejects.toThrow(
      /violates check constraint/,
    )
  })

  it('takes a real hash from the application, at either cost', async () => {
    await insertAdmin(
      'admin@example.com',
      await hashPassword('another decent password', ADMIN_SCRYPT),
    )
    await pool.query('UPDATE admin_account SET password_hash = $1', [
      await hashPassword('another decent password', LINK_SCRYPT),
    ])
  })

  it.each([
    ['lower case', 'abcdefghijklmnop'],
    ['a digit outside base32', 'ABCDEFGH01234567'],
    ['too short', 'ABCDEFGHIJKLMNO'],
  ])('refuses a TOTP secret in %s', async (_label, secret) => {
    await insertAdmin()
    await expect(pool.query('UPDATE admin_account SET totp_secret = $1', [secret])).rejects.toThrow(
      /violates check constraint/,
    )
  })

  it('takes a base32 TOTP secret and a step, and refuses a negative step', async () => {
    await insertAdmin()
    await pool.query('UPDATE admin_account SET totp_secret = $1, totp_last_step = 58000000', [
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    ])
    await expect(pool.query('UPDATE admin_account SET totp_last_step = -1')).rejects.toThrow(
      /violates check constraint/,
    )
    await expect(pool.query('UPDATE admin_account SET failed_logins = -1')).rejects.toThrow(
      /violates check constraint/,
    )
  })

  // D9: the secret an enrolment is confirming is the server's, held here until
  // a code proves the authenticator has it. Same alphabet as the live one.
  it('holds a pending TOTP secret, in base32, with the instant it was minted', async () => {
    await insertAdmin()
    await pool.query('UPDATE admin_account SET totp_pending_secret = $1, totp_pending_at = now()', [
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    ])
    const r = await pool.query<{ totp_pending_secret: string | null }>(
      'SELECT totp_pending_secret FROM admin_account',
    )
    expect(r.rows[0]?.totp_pending_secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    await expect(
      pool.query('UPDATE admin_account SET totp_pending_secret = $1', ['not base32!']),
    ).rejects.toThrow(/violates check constraint/)
    await pool.query('UPDATE admin_account SET totp_pending_secret = NULL, totp_pending_at = NULL')
  })
})

describe('postgres schema 006: recovery codes, sessions and API keys', () => {
  // A recovery code is ten characters a person copies onto paper, so it is
  // stored the way the password is and not as one fast digest — the column
  // carries the same CHECK the password columns do. What a backup holds must
  // not be ten fifty-bit candidates behind a single SHA-256 pass.
  it('stores a recovery code at password cost, and refuses anything else', async () => {
    const hash = await hashPassword('ABCDEFGHJK', ADMIN_SCRYPT)
    await pool.query('INSERT INTO admin_recovery_codes (code_hash) VALUES ($1)', [hash])
    for (const [label, bad] of [
      ['the code itself', 'ABCDEFGHJK'],
      ['its display form', 'ABCDE-FGHJK'],
      ['a bare SHA-256 digest, which is what this must not be', 'a'.repeat(64)],
      ['an empty value', ''],
    ] as [string, string][]) {
      await expect(
        pool.query('INSERT INTO admin_recovery_codes (code_hash) VALUES ($1)', [bad]),
        label,
      ).rejects.toThrow(/violates check constraint/)
    }
  })

  // Salted, so two rows for the same code are two different values and there
  // is nothing to make unique. The row's own id is what a spend updates by,
  // and `used_at` is what makes it one-time.
  it('takes the same code twice as two rows, each spendable once', async () => {
    const code = 'ABCDEFGHJK'
    const first = await pool.query<{ id: string }>(
      'INSERT INTO admin_recovery_codes (code_hash) VALUES ($1) RETURNING id',
      [await hashPassword(code, ADMIN_SCRYPT)],
    )
    await pool.query('INSERT INTO admin_recovery_codes (code_hash) VALUES ($1)', [
      await hashPassword(code, ADMIN_SCRYPT),
    ])
    const rows = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM admin_recovery_codes',
    )
    expect(rows.rows[0]?.n).toBe(2)
    const spend = await pool.query(
      'UPDATE admin_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [first.rows[0]?.id],
    )
    expect(spend.rowCount).toBe(1)
    const again = await pool.query(
      'UPDATE admin_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [first.rows[0]?.id],
    )
    expect(again.rowCount).toBe(0)
  })

  it('stores a session as a digest with an expiry, and refuses a duplicate digest', async () => {
    const hash = 'b'.repeat(64)
    await pool.query(
      "INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + interval '30 days')",
      [hash],
    )
    await expect(
      pool.query(
        "INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + interval '30 days')",
        [hash],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/)
    await expect(
      pool.query("INSERT INTO sessions (token_hash, expires_at) VALUES ('not-a-digest', now())"),
    ).rejects.toThrow(/violates check constraint/)
  })

  it('bounds what a session shows about a device', async () => {
    await expect(
      pool.query(
        'INSERT INTO sessions (token_hash, expires_at, user_agent) VALUES ($1, now(), $2)',
        ['c'.repeat(64), 'x'.repeat(201)],
      ),
    ).rejects.toThrow(/violates check constraint/)
    await expect(
      pool.query('INSERT INTO sessions (token_hash, expires_at, ip) VALUES ($1, now(), $2)', [
        'd'.repeat(64),
        'x'.repeat(46),
      ]),
    ).rejects.toThrow(/violates check constraint/)
  })

  it('stores an API key by its public id and its secret digest', async () => {
    await pool.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
      '0'.repeat(16),
      'reporting',
      'e'.repeat(64),
    ])
    await expect(
      pool.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
        'nothex0123456789',
        'x',
        'e'.repeat(64),
      ]),
    ).rejects.toThrow(/violates check constraint/)
    await expect(
      pool.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
        '1'.repeat(16),
        '',
        'e'.repeat(64),
      ]),
    ).rejects.toThrow(/violates check constraint/)
    await expect(
      pool.query('INSERT INTO api_keys (id, name, secret_hash) VALUES ($1, $2, $3)', [
        '2'.repeat(16),
        'x',
        'plain-secret',
      ]),
    ).rejects.toThrow(/violates check constraint/)
  })
})

describe('postgres schema 006: a link password', () => {
  const link = async () => {
    const d = await pool.query<{ id: string }>(
      "INSERT INTO domains (host) VALUES ('go.example.test') RETURNING id",
    )
    const l = await pool.query<{ id: string; password_hash: string | null }>(
      "INSERT INTO links (domain_id, slug) VALUES ($1, 'p') RETURNING id, password_hash",
      [d.rows[0]?.id],
    )
    return l.rows[0] as { id: string; password_hash: string | null }
  }

  it('has none by default', async () => {
    expect((await link()).password_hash).toBeNull()
  })

  it('takes a hash and refuses a plain password', async () => {
    const l = await link()
    // A link's own cost, derived here rather than reusing the admin's, so this
    // test also shows the column takes either frame.
    const linkHash = await hashPassword('spring2026', LINK_SCRYPT)
    await pool.query('UPDATE links SET password_hash = $1 WHERE id = $2', [linkHash, l.id])
    await expect(
      pool.query('UPDATE links SET password_hash = $1 WHERE id = $2', ['hunter2hunter2', l.id]),
    ).rejects.toThrow(/violates check constraint/)
    await expect(
      pool.query('UPDATE links SET password_hash = $1 WHERE id = $2', [
        frame('16384$8$1$c2E$x'),
        l.id,
      ]),
    ).rejects.toThrow(/violates check constraint/)
    await pool.query('UPDATE links SET password_hash = NULL WHERE id = $1', [l.id])
  })
})
