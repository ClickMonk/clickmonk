/**
 * Credentials the install stores: the admin's password, session tokens, API
 * keys, recovery codes and a link's password.
 *
 * Two shapes, and the difference matters. A *password* is chosen by a person,
 * so it is stored behind a deliberately slow hash (scrypt) with a per-password
 * salt, at a cost the caller names: someone holding the database still has to
 * pay that cost per guess. A
 * *token* this install mints is 32 random bytes, so guessing it is hopeless
 * and one pass of SHA-256 is enough — a slow hash there would only cost the
 * request path.
 *
 * Nothing here compares with `===`. A comparison that returns early on the
 * first differing byte leaks where it differed, and a stored digest is
 * compared against one the caller supplied.
 */
import {
  type ScryptOptions,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Promise form of `crypto.scrypt`, wrapped by hand rather than with
 * `promisify`: the callback form is overloaded, and promisify resolves to the
 * overload without options, which is the one that cannot carry the cost
 * parameters.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

/**
 * What a stored hash costs to make, and to make again when it is verified.
 * There is no default: every caller names which of the two below it is
 * storing, because a copy-paste that quietly stored the admin's password at a
 * link's cost would look correct and be weaker.
 */
export interface ScryptCost {
  N: number
  r: number
  p: number
}

/**
 * The admin's password: 32768 · 8 · 128 = 32 MiB, roughly 100 ms per hash on a
 * small VM. Paid once per sign-in, on a path an outsider cannot reach without
 * the admin host, and it is the one secret whose stolen hash is worth
 * attacking offline.
 */
export const ADMIN_SCRYPT: ScryptCost = { N: 32_768, r: 8, p: 1 }

/**
 * A link's password: 16384 · 8 · 128 = 16 MiB, roughly 50 ms. Verified on the
 * redirect's own request path, where the bound that protects it is the attempt
 * limiter — doubling the memory here hands an attacker a cheaper lever than it
 * costs them.
 */
export const LINK_SCRYPT: ScryptCost = { N: 16_384, r: 8, p: 1 }

/** The algorithm name the frame starts with. Never written as a literal elsewhere. */
export const SCRYPT_PREFIX = 'scrypt'
const SCRYPT_SALT_BYTES = 16
const SCRYPT_KEY_BYTES = 32
/**
 * Shortest key a *stored* hash may carry, well below what this build ever
 * writes (`SCRYPT_KEY_BYTES`). A key this short turns `timingSafeEqual` into
 * a coin flip: an unrelated password's derived key of the same short length
 * has a real chance of matching it by coincidence, not by being the right
 * password.
 */
const MIN_SCRYPT_KEY_BYTES = 16

/**
 * The most memory a *stored* hash may ask for when it is verified: 64 MiB.
 * The parameters travel in the hash so that raising the cost later still
 * verifies today's passwords — which means a row written by hand could ask
 * for gigabytes and stall the process that reads it. A hash over this bound
 * is refused rather than computed.
 */
export const MAX_SCRYPT_MEMORY_BYTES = 64 * 1024 * 1024

/**
 * Storage bounds, not policy: hashing is bounded, and nothing empty is
 * hashed. How long a password has to *be* is each caller's rule — the admin's
 * is MIN_ADMIN_PASSWORD_LENGTH, a link's is MIN_LINK_PASSWORD_LENGTH — because
 * an admin password guards the whole install while a link password guards one
 * destination, and the two floors are not the same decision.
 */
export const MAX_PASSWORD_LENGTH = 200
export const MIN_ADMIN_PASSWORD_LENGTH = 12
export const MIN_LINK_PASSWORD_LENGTH = 6
/** The column's bound, and the longest stored hash a verifier will parse. */
export const MAX_PASSWORD_HASH_LENGTH = 200

const B64 = /^[A-Za-z0-9_-]+$/

function scryptMemory(n: number, r: number, p: number): number {
  return 128 * n * r * p
}

/**
 * `scrypt$<N>$<r>$<p>$<salt>$<key>`, both values base64url. The cost is the
 * caller's — `ADMIN_SCRYPT` or `LINK_SCRYPT` — and it is stored with the hash,
 * so raising either later still verifies every password stored under the old
 * one, and `verifyPassword` needs no cost argument at all.
 */
export async function hashPassword(password: string, cost: ScryptCost): Promise<string> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`a password is between 1 and ${MAX_PASSWORD_LENGTH} characters`)
  }
  if (scryptMemory(cost.N, cost.r, cost.p) > MAX_SCRYPT_MEMORY_BYTES) {
    throw new Error('that scrypt cost asks for more memory than this build allows')
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const key = await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    maxmem: MAX_SCRYPT_MEMORY_BYTES,
  })
  return [
    SCRYPT_PREFIX,
    cost.N,
    cost.r,
    cost.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

interface StoredHash {
  n: number
  r: number
  p: number
  salt: Buffer
  key: Buffer
}

function parseStoredHash(stored: string): StoredHash | null {
  if (stored.length > MAX_PASSWORD_HASH_LENGTH) return null
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return null
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  for (const v of [n, r, p]) {
    if (!Number.isInteger(v) || v < 1) return null
  }
  // scrypt's own cost parameter, and the only one required to be a power of
  // two: refusing it here keeps that requirement ours to state, rather than
  // relying on whatever the underlying scrypt call happens to validate.
  if (!(n >= 2 && (n & (n - 1)) === 0)) return null
  if (scryptMemory(n, r, p) > MAX_SCRYPT_MEMORY_BYTES) return null
  const [saltText, keyText] = [parts[4] as string, parts[5] as string]
  if (!B64.test(saltText) || !B64.test(keyText)) return null
  const salt = Buffer.from(saltText, 'base64url')
  const key = Buffer.from(keyText, 'base64url')
  if (salt.length === 0 || key.length < MIN_SCRYPT_KEY_BYTES || key.length > 64) return null
  return { n, r, p, salt, key }
}

/**
 * True only for the password this hash was made from. A stored value this
 * cannot parse, or one asking for more memory than the bound allows, is false
 * — never an exception, because that would turn a bad row into a 500 on a
 * login or on the redirect path. The parse sits inside the same catch as the
 * scrypt call: a stored value that is not even a string — a NULL column read
 * straight off a row, past whatever this build's own types claim — throws
 * just as synchronously as a malformed one, and both need the same answer.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false
  try {
    const parsed = parseStoredHash(stored)
    if (!parsed) return false
    const key = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    })
    return timingSafeEqual(key, parsed.key)
  } catch {
    return false
  }
}

/**
 * A fingerprint of a stored hash, for binding a cookie to the password that
 * was in force when it was issued: changing the password changes this, so
 * every proof issued under the old one stops verifying. Not a secret — it is
 * 8 bytes of a digest of a salted hash — and never enough to attack the
 * password with.
 */
export function passwordFingerprint(storedHash: string): string {
  return createHash('sha256').update(`cm_pw_fp:${storedHash}`).digest('hex').slice(0, 16)
}

/** 32 bytes of randomness as base64url: a session token, or an API key's secret half. */
export const TOKEN_BYTES = 32

export function newOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** What is stored for a token: a token is high-entropy, so one pass of SHA-256 is enough. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison of two lower-case hex digests of the same length. */
export function digestsMatch(a: string, b: string): boolean {
  // Bounded on the shorter argument's *byte* length, not `.length`: a string's
  // `.length` counts UTF-16 code units, which is not the byte length a
  // multibyte character encodes to, and timingSafeEqual compares bytes.
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

/** An API key as the admin sees it once: `cmk_<16 hex id>_<token>`. */
export const API_KEY_PREFIX = 'cmk_'
export const API_KEY_ID_RE = /^[0-9a-f]{16}$/
/** Longer than any key this mints, short enough that parsing one is bounded. */
export const MAX_API_KEY_LENGTH = 128

export interface NewApiKey {
  /** Stored in the clear and used to find the row; not a secret. */
  id: string
  /** Never stored: only its digest is. */
  secret: string
  /** What the admin copies. Shown once. */
  display: string
}

export function newApiKey(): NewApiKey {
  const id = randomBytes(8).toString('hex')
  const secret = newOpaqueToken()
  return { id, secret, display: `${API_KEY_PREFIX}${id}_${secret}` }
}

/**
 * Splits a presented key into the id to look up and the secret to compare.
 * The id is what makes this one indexed lookup rather than a scan of every
 * key's digest.
 */
export function parseApiKey(presented: string): { id: string; secret: string } | null {
  if (presented.length > MAX_API_KEY_LENGTH || !presented.startsWith(API_KEY_PREFIX)) return null
  const rest = presented.slice(API_KEY_PREFIX.length)
  const underscore = rest.indexOf('_')
  if (underscore === -1) return null
  const id = rest.slice(0, underscore)
  const secret = rest.slice(underscore + 1)
  if (!API_KEY_ID_RE.test(id) || !B64.test(secret)) return null
  return { id, secret }
}

/**
 * Recovery codes: what the admin uses when the authenticator app is gone.
 * Crockford's base32 alphabet without I, L, O and U, so a code read off
 * paper has no character pairs to confuse, in two groups of five.
 *
 * A code is stored and verified with `hashPassword`/`verifyPassword` at
 * `ADMIN_SCRYPT`, the same as the admin's password — never `hashToken`. Fifty
 * bits under one unsalted SHA-256 pass is a stolen dump away from a TOTP
 * bypass measured in GPU-hours; a code is checked at most once, ever, so the
 * scrypt cost is paid a single time and is free at that rate. `newRecoveryCode`
 * stays at 10 characters either way — the cost of guessing it, not its
 * length, is what changes.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const RECOVERY_CODE_COUNT = 10
const RECOVERY_CODE_CHARS = 10

/** One code's display form, `XXXXX-XXXXX`. Each is 50 bits of randomness. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_CHARS)
  let out = ''
  for (const b of bytes) out += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]
  return `${out.slice(0, 5)}-${out.slice(5)}`
}

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => newRecoveryCode())
}

/**
 * The form a code is stored and compared under: upper-cased, with spaces and
 * dashes removed, so what the admin types matches what was printed however
 * they copied it. Null when it cannot be one of ours, so a hostile body is
 * never hashed and looked up.
 */
export function normaliseRecoveryCode(input: string): string | null {
  if (input.length > 32) return null
  const stripped = input.toUpperCase().replace(/[\s-]/g, '')
  if (stripped.length !== RECOVERY_CODE_CHARS) return null
  for (const ch of stripped) {
    if (!RECOVERY_ALPHABET.includes(ch)) return null
  }
  return stripped
}
