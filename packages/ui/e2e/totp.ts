import { createHmac } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The thirty-second step an instant falls in. */
export const STEP_MS = 30_000

function base32(secret: string): Buffer {
  let bits = ''
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) {
    const i = ALPHABET.indexOf(c)
    if (i === -1) throw new Error(`not a base32 character: ${c}`)
    bits += i.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The six-digit code for the thirty-second step `offset` steps from now (RFC 6238, SHA-1). */
export function totp(secret: string, nowMs = Date.now(), offset = 0): string {
  const step = Math.floor(nowMs / STEP_MS) + offset
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', base32(secret)).update(counter).digest()
  const o = (h[h.length - 1] ?? 0) & 0x0f
  const n =
    (((h[o] ?? 0) & 0x7f) << 24) |
    ((h[o + 1] ?? 0) << 16) |
    ((h[o + 2] ?? 0) << 8) |
    (h[o + 3] ?? 0)
  return String(n % 1_000_000).padStart(6, '0')
}
