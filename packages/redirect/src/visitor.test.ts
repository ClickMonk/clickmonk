import { describe, expect, it } from 'vitest'
import { MAX_SEEN, readVisitor, visitorCookies } from './visitor.js'

const SECRET = 'test-secret-that-is-long-enough-000000'
const ID_A = '00000000-0000-4000-8000-0000000000a1'
const ID_B = '00000000-0000-4000-8000-0000000000b2'

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

describe('visitor cookies', () => {
  it('mints a new visitor when there is no cookie', () => {
    const v = readVisitor(undefined, SECRET)
    expect(v.isNew).toBe(true)
    expect(v.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(v.seen).toEqual([])
  })

  it('round-trips the visitor id and the seen list', () => {
    const v = readVisitor(undefined, SECRET)
    const header = cookieHeaderFrom(visitorCookies(v, ID_A, SECRET))
    const back = readVisitor(header, SECRET)
    expect(back).toEqual({ id: v.id, isNew: false, seen: [ID_A] })
  })

  it('puts the latest link first and does not repeat it', () => {
    let v = readVisitor(undefined, SECRET)
    for (const id of [ID_A, ID_B, ID_A])
      v = readVisitor(cookieHeaderFrom(visitorCookies(v, id, SECRET)), SECRET)
    expect(v.seen).toEqual([ID_A, ID_B])
  })

  it(`writes at most ${MAX_SEEN} links into the cookie`, () => {
    // Asserted on the cookie that is SENT, not on what readVisitor returns:
    // the reader also truncates, so a reader-side check would pass even if
    // the writer grew the cookie without bound.
    const seen = Array.from(
      { length: MAX_SEEN + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    )
    const v = { id: 'a'.repeat(22), isNew: false, seen }
    const cookie = visitorCookies(v, ID_A, SECRET).find((c) => c.startsWith('cm_seen=')) as string
    const payload = cookie.slice('cm_seen='.length, cookie.indexOf('.'))
    expect(Buffer.from(payload, 'base64url').toString('utf8').split(',')).toHaveLength(MAX_SEEN)
  })

  it('ignores a tampered or foreign seen list', () => {
    const v = readVisitor(undefined, SECRET)
    const header = cookieHeaderFrom(visitorCookies(v, ID_A, SECRET))
    const forged = header.replace(
      /cm_seen=[^;]+/,
      `cm_seen=${Buffer.from(ID_B).toString('base64url')}.AAAA`,
    )
    expect(readVisitor(forged, SECRET).seen).toEqual([])
    expect(readVisitor(header, 'another-secret-that-is-long-enough-00').seen).toEqual([])

    // A genuine tag moved onto a different payload must not verify: the
    // signature has to cover the payload, not just a constant label.
    const genuineTag = header.match(/cm_seen=[^.]+\.([^;]+)/)?.[1]
    const swappedPayload = header.replace(
      /cm_seen=[^;]+/,
      `cm_seen=${Buffer.from(ID_B).toString('base64url')}.${genuineTag}`,
    )
    expect(readVisitor(swappedPayload, SECRET).seen).toEqual([])

    // A same-length (16-byte) but wrong tag must fail the byte comparison
    // itself, not only a length check.
    const zeroTag = Buffer.alloc(16).toString('base64url')
    const zeroTagged = header.replace(/(cm_seen=[^.;]+\.)[^;]+/, `$1${zeroTag}`)
    expect(readVisitor(zeroTagged, SECRET).seen).toEqual([])
  })

  it('rejects a malformed visitor id and mints a new one', () => {
    expect(readVisitor('cm_vid=../../etc', SECRET).isNew).toBe(true)
  })

  it('sets long-lived, HttpOnly, Secure, SameSite=Lax cookies', () => {
    const cookies = visitorCookies(readVisitor(undefined, SECRET), ID_A, SECRET)
    for (const c of cookies)
      expect(c).toMatch(/; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax$/)
  })

  it('sends no seen cookie when there is nothing to record', () => {
    const cookies = visitorCookies(readVisitor(undefined, SECRET), null, SECRET)
    expect(cookies.some((c) => c.startsWith('cm_seen='))).toBe(false)
    expect(cookies.some((c) => c.startsWith('cm_vid='))).toBe(true)
  })

  it('bounds the cookie header it will parse', () => {
    expect(() => readVisitor(`cm_vid=${'a'.repeat(100_000)}`, SECRET)).not.toThrow()
  })
})
