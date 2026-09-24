import { scrypt as nodeScrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_SCRYPT,
  API_KEY_PREFIX,
  LINK_SCRYPT,
  MAX_PASSWORD_LENGTH,
  MAX_SCRYPT_MEMORY_BYTES,
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

const scryptRaw = promisify(nodeScrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: Record<string, unknown>,
) => Promise<Buffer>

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
    const b64salt = Buffer.from('salt').toString('base64url')
    const b64hash = Buffer.from('hash').toString('base64url')
    const b64zeroKey = Buffer.alloc(32).toString('base64url')
    for (const bad of [
      '',
      'not-a-hash',
      frame('16384$8$1$only-five-parts'),
      `argon2$16384$8$1$${b64salt}$${b64hash}`,
      frame(`0$8$1$${b64salt}$${b64hash}`),
      frame(`16384$8$1$${b64salt}$`),
      frame(`16384$8$1$!!!$${b64hash}`),
      // N must be a power of two: scrypt's own algorithm requires it, so a
      // stored row naming one that is not is invalid and must be refused.
      frame(`3$8$1$${b64salt}$${b64zeroKey}`),
    ]) {
      expect(await verifyPassword('correct horse battery', bad), bad).toBe(false)
    }
  })

  it('never rejects, even for a stored value that is not a string at all', async () => {
    // A NULL column read straight off a row is exactly this: it bypasses
    // whatever this build's own types claim `stored` will be. The parse has
    // to fail as gracefully as a malformed string does, not throw before it
    // is ever reached.
    await expect(verifyPassword('correct horse battery', null as unknown as string)).resolves.toBe(
      false,
    )
  })

  it('verifies a stored hash whose key is shorter than this build writes', async () => {
    // Every hash `hashPassword` writes carries a 32-byte key, so nothing else
    // here notices whether verification derives its candidate at the *stored*
    // key's length or at a constant 32. A hash written by a build with a
    // different key length, or by another implementation, is the case that does:
    // at a constant, the candidate is 32 bytes against a 16-byte stored key,
    // `timingSafeEqual` throws on the mismatch, and the right password is read
    // as wrong. The length is also why this call needs no length comparison in
    // front of it, which is a claim nothing else in this suite tests.
    const salt = Buffer.from('a-salt-of-sixteen')
    const key = await scryptRaw('correct horse battery', salt, 16, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    })
    expect(key).toHaveLength(16)
    const stored = frame(`16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`)
    expect(await verifyPassword('correct horse battery', stored)).toBe(true)
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false)
  })

  it('refuses a stored hash whose key is too short to trust a match', async () => {
    // Built from the exact byte scrypt derives for this password under this
    // salt and cost, at a one-byte key length: without a floor on the stored
    // key's length, this is not a row the parser merely tolerates — it is one
    // that would verify as this password's hash, because a one-byte key is a
    // coin flip, not because it is the right password.
    const salt = Buffer.from('salt')
    const shortKey = await scryptRaw('correct horse battery', salt, 1, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    })
    const hostile = frame(
      `16384$8$1$${salt.toString('base64url')}$${shortKey.toString('base64url')}`,
    )
    await expect(verifyPassword('correct horse battery', hostile)).resolves.toBe(false)
  })

  it('refuses a stored hash that asks for more memory than the bound allows', async () => {
    // 128 · 2^20 · 8 = 1 GiB. A row written by hand could otherwise stall
    // whichever process verifies against it, so this is refused before the
    // scrypt call rather than left to it: the catch around that call means
    // this now resolves false either way, so this pins the *outcome*, not
    // which of the two guards produced it. Nothing here times the call — a
    // clock on a machine that is also building images is a flake.
    const salt = Buffer.from('salt').toString('base64url')
    const key = Buffer.alloc(32).toString('base64url')
    const hostile = frame(`${1024 * 1024}$8$1$${salt}$${key}`)
    await expect(verifyPassword('correct horse battery', hostile)).resolves.toBe(false)
  })

  it('never rejects, even when scrypt itself refuses parameters our own bound accepts', async () => {
    // 128 · 2 · 262144 · 1 = 67108864, exactly MAX_SCRYPT_MEMORY_BYTES — this
    // build's own bound lets it through, but scrypt's internal accounting has
    // overhead ours does not model, so the call itself still throws. That gap
    // is why verifyPassword needs its own catch rather than trusting that
    // whatever passes this build's checks is safe to hand to scrypt.
    const salt = Buffer.from('salt').toString('base64url')
    const key = Buffer.alloc(32).toString('base64url')
    const hostile = frame(`2$262144$1$${salt}$${key}`)
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
    // One multibyte character keeps the same UTF-16 length (64) as a real
    // digest but not the same byte length: a length check on .length rather
    // than on bytes would let this pair through to timingSafeEqual, which
    // throws for buffers of different length rather than returning false.
    const multibyte = `${digest.slice(0, 63)}é`
    expect(multibyte).toHaveLength(64)
    expect(digestsMatch(digest, multibyte)).toBe(false)
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

  it('is verified as a password, at the admin cost, not as a token', async () => {
    // A stored recovery code is hashPassword(normalised, ADMIN_SCRYPT), never
    // hashToken: a code is checked at most once, ever, so the cost is paid a
    // single time, and an unsalted single SHA-256 pass would put a stolen
    // dump's fifty bits of randomness within reach of an offline attacker.
    const code = normaliseRecoveryCode(newRecoveryCode()) as string
    const stored = await hashPassword(code, ADMIN_SCRYPT)
    expect(await verifyPassword(code, stored)).toBe(true)
    expect(await verifyPassword('WRONGWRONG', stored)).toBe(false)
  })
})
