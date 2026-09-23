import { describe, expect, it } from 'vitest'
import {
  ADMIN_SCRYPT,
  API_KEY_PREFIX,
  LINK_SCRYPT,
  MAX_PASSWORD_LENGTH,
  SCRYPT_PREFIX,
  digestsMatch,
  hashPassword,
  hashToken,
  newApiKey,
  newOpaqueToken,
  newRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  parseApiKey,
  passwordFingerprint,
  verifyPassword,
} from './secrets.js'

/**
 * A stored-hash frame built rather than written out. Nothing in this
 * repository may contain a literal that reads like a stored password, so even
 * the deliberately invalid examples below are assembled from the prefix.
 */
const frame = (rest: string): string => `${SCRYPT_PREFIX}$${rest}`

describe('storing a password', () => {
  it('verifies the password it was made from and nothing else', async () => {
    const stored = await hashPassword('correct horse battery', LINK_SCRYPT)
    expect(await verifyPassword('correct horse battery', stored)).toBe(true)
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('salts, so the same password twice is two different hashes', async () => {
    const a = await hashPassword('correct horse battery', LINK_SCRYPT)
    const b = await hashPassword('correct horse battery', LINK_SCRYPT)
    expect(a).not.toBe(b)
    expect(await verifyPassword('correct horse battery', b)).toBe(true)
  })

  it('never stores the password itself, and frames the cost it was made with', async () => {
    const link = await hashPassword('correct horse battery', LINK_SCRYPT)
    expect(link).not.toContain('correct')
    expect(link.startsWith(frame('16384$8$1$'))).toBe(true)
    // The admin's cost is a different number in the same frame, which is what
    // makes raising either one later a parameter change and nothing else.
    const admin = await hashPassword('correct horse battery', ADMIN_SCRYPT)
    expect(admin.startsWith(frame('32768$8$1$'))).toBe(true)
    // Nothing is verified here on purpose: that a hash verifies at whatever
    // cost it carries is the next test's, so each of the two mutations —
    // ignoring the caller's cost, and verifying at a fixed one — fails exactly
    // one of them.
  })

  // A hash stored at one cost keeps verifying after the default moves, which
  // is the whole reason the parameters travel in the frame.
  it('verifies a hash whatever cost it was stored at, with no cost argument', async () => {
    for (const cost of [LINK_SCRYPT, ADMIN_SCRYPT]) {
      const stored = await hashPassword('correct horse battery', cost)
      expect(await verifyPassword('correct horse battery', stored), String(cost.N)).toBe(true)
    }
  })

  it('refuses an empty password or one longer than the storage bound', async () => {
    await expect(hashPassword('', LINK_SCRYPT)).rejects.toThrow('between')
    await expect(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), LINK_SCRYPT)).rejects.toThrow(
      'between',
    )
    // The floors are policy, and each caller's own: hashing a six-character
    // password is what a link password needs.
    expect(await verifyPassword('spring', await hashPassword('spring', LINK_SCRYPT))).toBe(true)
  })

  it('refuses a stored value it cannot parse, rather than throwing', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      frame('16384$8$1$only-five-parts'),
      'argon2$16384$8$1$c2FsdA$aGFzaA',
      frame('0$8$1$c2FsdA$aGFzaA'),
      frame('16384$8$1$c2FsdA$'),
      frame('16384$8$1$!!!$aGFzaA'),
    ]) {
      expect(await verifyPassword('correct horse battery', bad), bad).toBe(false)
    }
  })

  it('refuses a stored hash that asks for more memory than the bound allows', async () => {
    // 128 · 2^20 · 8 = 1 GiB. A row written by hand could otherwise stall
    // whichever process verifies against it. What discriminates is that this
    // RESOLVES to false: without the bound, scrypt itself refuses by throwing,
    // and a sign-in or a click becomes a 500. Nothing here times the call —
    // a clock on a machine that is also building images is a flake.
    const salt = Buffer.from('salt').toString('base64url')
    const key = Buffer.alloc(32).toString('base64url')
    const hostile = frame(`${1024 * 1024}$8$1$${salt}$${key}`)
    await expect(verifyPassword('correct horse battery', hostile)).resolves.toBe(false)
  })

  it('fingerprints a stored hash, so a new password invalidates old proofs', async () => {
    const a = await hashPassword('correct horse battery', LINK_SCRYPT)
    const b = await hashPassword('correct horse battery', LINK_SCRYPT)
    expect(passwordFingerprint(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(passwordFingerprint(a)).toBe(passwordFingerprint(a))
    expect(passwordFingerprint(a)).not.toBe(passwordFingerprint(b))
  })
})

describe('tokens this install mints', () => {
  it('is 32 bytes of randomness, and different every time', () => {
    const a = newOpaqueToken()
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(newOpaqueToken())
  })

  it('stores a digest, not the token', () => {
    const token = newOpaqueToken()
    const digest = hashToken(token)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(token)
    expect(hashToken(token)).toBe(digest)
    expect(hashToken(newOpaqueToken())).not.toBe(digest)
  })

  it('compares digests only at equal length, and only when they are equal', () => {
    const digest = hashToken('a')
    expect(digestsMatch(digest, hashToken('a'))).toBe(true)
    expect(digestsMatch(digest, hashToken('b'))).toBe(false)
    expect(digestsMatch(digest, digest.slice(0, 63))).toBe(false)
    expect(digestsMatch('', '')).toBe(false)
  })
})

describe('an API key', () => {
  it('carries an id to look up and a secret to compare', () => {
    const key = newApiKey()
    expect(key.display).toBe(`${API_KEY_PREFIX}${key.id}_${key.secret}`)
    expect(parseApiKey(key.display)).toEqual({ id: key.id, secret: key.secret })
    expect(key.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('refuses anything that is not one of ours', () => {
    for (const bad of [
      '',
      'cmk_',
      'cmk_nosecret',
      `cmk_${'z'.repeat(16)}_secret`,
      'cmk_0123456789abcde_secret',
      `bearer_${'0'.repeat(16)}_secret`,
      `cmk_${'0'.repeat(16)}_secret with spaces`,
      `cmk_${'0'.repeat(16)}_${'x'.repeat(200)}`,
    ]) {
      expect(parseApiKey(bad), bad).toBeNull()
    }
  })
})

describe('recovery codes', () => {
  it('is ten characters in two readable groups, from an alphabet with no I, L, O or U', () => {
    for (let i = 0; i < 50; i++) {
      expect(newRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    }
    expect(newRecoveryCodes()).toHaveLength(10)
    expect(new Set(newRecoveryCodes(10)).size).toBe(10)
  })

  it('accepts a code however it was copied, and refuses one that cannot be ours', () => {
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK')
    expect(normaliseRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK')
    expect(normaliseRecoveryCode('ABCDEFGHJ')).toBeNull()
    expect(normaliseRecoveryCode('ABCDEFGHJKL')).toBeNull()
    expect(normaliseRecoveryCode('ABCDEFGHJI')).toBeNull()
    expect(normaliseRecoveryCode('x'.repeat(40))).toBeNull()
  })
})
