import { describe, expect, it } from 'vitest'
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  newTotpSecret,
  normaliseTotpCode,
  totpCode,
  totpStep,
  totpUri,
  verifyTotp,
} from './totp.js'

/** RFC 6238's test secret, "12345678901234567890" in base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'utf8'))

describe('base32', () => {
  it('round-trips bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    expect(base32Encode(Buffer.from('12345678901234567890', 'utf8'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    )
  })

  it('refuses anything that is not base32', () => {
    expect(base32Decode('')).toBeNull()
    expect(base32Decode('01890')).toBeNull()
    expect(base32Decode('ABC!')).toBeNull()
    expect(base32Decode('A'.repeat(65))).toBeNull()
  })
})

describe('the codes an authenticator app produces', () => {
  // RFC 6238, appendix B, the SHA-1 rows: the eight-digit values at these
  // instants are 94287082, 07081804, 89005924 and 69279037, and a six-digit
  // code is the last six digits of each.
  it('matches RFC 6238 at the published instants', () => {
    expect(totpCode(RFC_SECRET, totpStep(59_000))).toBe('287082')
    expect(totpCode(RFC_SECRET, totpStep(1_111_111_109_000))).toBe('081804')
    expect(totpCode(RFC_SECRET, totpStep(1_234_567_890_000))).toBe('005924')
    expect(totpCode(RFC_SECRET, totpStep(2_000_000_000_000))).toBe('279037')
  })

  it('steps every thirty seconds', () => {
    expect(totpStep(0)).toBe(0)
    expect(totpStep(TOTP_STEP_SECONDS * 1000 - 1)).toBe(0)
    expect(totpStep(TOTP_STEP_SECONDS * 1000)).toBe(1)
  })

  it('mints a 160-bit secret, different every time', () => {
    const secret = newTotpSecret()
    expect(base32Decode(secret)).toHaveLength(20)
    expect(secret).not.toBe(newTotpSecret())
  })

  it('reads a code however it was typed', () => {
    expect(normaliseTotpCode('123 456')).toBe('123456')
    expect(normaliseTotpCode('123-456')).toBe('123456')
    expect(normaliseTotpCode('12345')).toBeNull()
    expect(normaliseTotpCode('1234567')).toBeNull()
    expect(normaliseTotpCode('abcdef')).toBeNull()
  })

  it('names the install in the URI an app reads', () => {
    const uri = totpUri({ secret: RFC_SECRET, account: 'admin@example.com', issuer: 'ClickMonk' })
    expect(uri).toBe(
      `otpauth://totp/ClickMonk:admin%40example.com?secret=${RFC_SECRET}&issuer=ClickMonk&algorithm=SHA1&digits=6&period=30`,
    )
  })
})

describe('verifying a code', () => {
  const atMs = 1_700_000_000_000
  const now = totpStep(atMs)

  it('accepts this step and one either side, and nothing further out', () => {
    for (const offset of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET, now + offset) as string
      expect(
        verifyTotp({ secret: RFC_SECRET, code, atMs, lastStep: null }),
        String(offset),
      ).toEqual({ step: now + offset })
    }
    for (const offset of [-2, 2]) {
      const code = totpCode(RFC_SECRET, now + offset) as string
      expect(
        verifyTotp({ secret: RFC_SECRET, code, atMs, lastStep: null }),
        String(offset),
      ).toBeNull()
    }
  })

  it('refuses a code already used, and every step at or below it', () => {
    const code = totpCode(RFC_SECRET, now) as string
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs, lastStep: null })).toEqual({ step: now })
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs, lastStep: now })).toBeNull()
    const previous = totpCode(RFC_SECRET, now - 1) as string
    expect(verifyTotp({ secret: RFC_SECRET, code: previous, atMs, lastStep: now })).toBeNull()
    const next = totpCode(RFC_SECRET, now + 1) as string
    expect(verifyTotp({ secret: RFC_SECRET, code: next, atMs, lastStep: now })).toEqual({
      step: now + 1,
    })
  })

  it('refuses a wrong code, a wrong secret and a secret that is not base32', () => {
    const code = totpCode(RFC_SECRET, now) as string
    expect(verifyTotp({ secret: RFC_SECRET, code: '000000', atMs, lastStep: null })).toBeNull()
    expect(verifyTotp({ secret: newTotpSecret(), code, atMs, lastStep: null })).toBeNull()
    expect(verifyTotp({ secret: '!!!', code, atMs, lastStep: null })).toBeNull()
    expect(verifyTotp({ secret: RFC_SECRET, code: 'abcdef', atMs, lastStep: null })).toBeNull()
  })
})
