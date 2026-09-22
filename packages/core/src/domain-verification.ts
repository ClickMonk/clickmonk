/**
 * Proving that the person adding a link domain controls it. The install
 * generates a random token per domain and the admin publishes it as a TXT
 * record; the worker looks that record up before the domain is marked
 * verified, and only a verified domain is allowed a certificate.
 *
 * The token is not a secret: it is published in DNS. What matters is that
 * nobody but this install chooses it, so pointing someone else's host name
 * at this server proves nothing.
 */

/** The label the TXT record lives under, so it never collides with the domain's own records. */
export const VERIFICATION_LABEL = '_clickmonk'

/** What the TXT record says, before the token. */
export const VERIFICATION_PREFIX = 'clickmonk-verify='

/** 16 random bytes as lower-case hex. */
export const VERIFICATION_TOKEN_RE = /^[0-9a-f]{32}$/

/** TXT records considered at one name. Past this the answer is no; a name with more is not ours. */
export const MAX_TXT_RECORDS = 20

/** The longest TXT value compared. The record this install asks for is 49 bytes. */
export const MAX_TXT_VALUE_LENGTH = 512

/**
 * Chunks read per record, regardless of their total length. The byte total
 * below only grows on a non-empty chunk, so a record built from many
 * zero-length chunks would otherwise never trip the value bound and would be
 * walked forever; this bound is checked first, and costs nothing to check.
 * The record this install asks for is one chunk, occasionally two.
 */
export const MAX_TXT_CHUNKS_PER_RECORD = 8

/** A new token. Web Crypto, which Node exposes globally, so this module stays free of node: imports. */
export function newVerificationToken(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function isVerificationToken(s: string): boolean {
  return VERIFICATION_TOKEN_RE.test(s)
}

/** The name the TXT record is published at, for `go.example.com`: `_clickmonk.go.example.com`. */
export function verificationRecordName(host: string): string {
  return `${VERIFICATION_LABEL}.${host}`
}

/** The value that record must hold. */
export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_PREFIX}${token}`
}

/**
 * True when one of the TXT records at the verification name carries this
 * token. A resolver returns each record as its chunks, because a TXT string
 * is at most 255 bytes and a longer value is published as several; they are
 * joined with nothing between them, which is what every resolver client does.
 *
 * Surrounding whitespace is ignored, because DNS control panels add it. The
 * comparison is otherwise exact: a record that merely contains the token
 * somewhere is not this install's record.
 */
export function txtRecordsCarryToken(
  records: readonly (readonly string[])[],
  token: string,
): boolean {
  if (!isVerificationToken(token)) return false
  const want = verificationRecordValue(token)
  for (const chunks of records.slice(0, MAX_TXT_RECORDS)) {
    // Bounded before joining: a hostile answer can hold many long chunks, or
    // many empty ones.
    if (chunks.length > MAX_TXT_CHUNKS_PER_RECORD) continue
    let total = 0
    let over = false
    for (const c of chunks) {
      total += c.length
      if (total > MAX_TXT_VALUE_LENGTH) {
        over = true
        break
      }
    }
    if (over) continue
    if (chunks.join('').trim() === want) return true
  }
  return false
}
