/**
 * Time-based one-time passwords (RFC 6238) for the single admin account, and
 * nothing else: HMAC-SHA1, six digits, a thirty-second step, which is what
 * every authenticator app implements.
 *
 * Two properties beyond "the code matches":
 *
 * - **A code is accepted once.** The step it was generated for is returned so
 *   the caller can store it and refuse anything at or below it next time.
 *   Without that, a code read over someone's shoulder — or replayed out of a
 *   proxy log — works for the rest of its thirty seconds and the next window.
 * - **The window is one step either side**, no more. Each extra step widens
 *   the guessing surface and the replay window for nothing: a clock that far
 *   out is a clock to fix.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps accepted either side of the current one, for a clock that is slightly off. */
export const TOTP_WINDOW_STEPS = 1
const SECRET_BYTES = 20
/** A base32 secret longer than this is not one of ours; refused before it is decoded. */
export const MAX_TOTP_SECRET_LENGTH = 64

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Null for anything that is not base32, so a hostile stored secret is never used. */
export function base32Decode(text: string): Buffer | null {
  if (text.length === 0 || text.length > MAX_TOTP_SECRET_LENGTH) return null
  const clean = text.toUpperCase().replace(/=+$/, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return bytes.length === 0 ? null : Buffer.from(bytes)
}

/** 160 bits, the length RFC 4226 recommends for HMAC-SHA1, as base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES))
}

/** Which thirty-second step an instant falls in. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS)
}

/** The six digits for one step, zero-padded. */
export function totpCode(secret: string, step: number): string | null {
  const key = base32Decode(secret)
  if (!key) return null
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(step))))
  const mac = createHmac('sha1', key).update(counter).digest()
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** Only the digits, so a code pasted as `123 456` is the code it looks like. */
export function normaliseTotpCode(input: string): string | null {
  if (input.length > 16) return null
  const digits = input.replace(/[\s-]/g, '')
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits) ? digits : null
}

export interface TotpCheck {
  /** The step the code belongs to, for the caller to store. */
  step: number
}

/**
 * Accepts the code for the current step or one step either side, and only
 * above `lastStep` — the step whose code was last accepted — so a code cannot
 * be used twice. Null means no.
 *
 * Every candidate is compared in constant time, and every step in the window
 * is compared whether an earlier one matched or not, so the answer takes the
 * same work whichever step was right.
 */
export function verifyTotp(o: {
  secret: string
  code: string
  atMs: number
  /** The last step accepted for this account, or null if none has been. */
  lastStep: number | null
}): TotpCheck | null {
  const code = normaliseTotpCode(o.code)
  if (!code) return null
  const now = totpStep(o.atMs)
  let matched: number | null = null
  for (let step = now - TOTP_WINDOW_STEPS; step <= now + TOTP_WINDOW_STEPS; step++) {
    const expected = totpCode(o.secret, step)
    if (expected === null) return null
    const same =
      expected.length === code.length &&
      timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(code, 'utf8'))
    if (same && matched === null) matched = step
  }
  if (matched === null) return null
  if (o.lastStep !== null && matched <= o.lastStep) return null
  return { step: matched }
}

/**
 * The `otpauth://` URI an authenticator app reads, for the admin to copy or
 * for a later UI to draw as a QR code. The label carries the install's own
 * host name so an admin with several installs can tell them apart.
 */
export function totpUri(o: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`
  const query = new URLSearchParams({
    secret: o.secret,
    issuer: o.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${query.toString()}`
}
