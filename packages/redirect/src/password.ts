/**
 * The password gate on a link, as the visitor meets it.
 *
 * Everything here happens on the link's own host name: the form is served at
 * the link's URL and posted back to it, so the proof cookie is first-party to
 * that domain and the visitor never leaves the host they clicked. The admin
 * service is not involved at all.
 *
 * What the gate must not become:
 *
 * - **An oracle.** The page is the same page whether the link has just been
 *   opened or a wrong password was typed, apart from one fixed line, and it
 *   never echoes what was typed. A slug with no password behaves exactly as an
 *   unknown slug does today.
 * - **A way to spend the process.** Verifying a password costs 16 MiB and tens
 *   of milliseconds by design, so attempts are counted per address and link and
 *   refused past a small number, and only a couple of checks ever run at once.
 * - **A proof that outlives the password.** The cookie is signed over the link
 *   id *and* a fingerprint of the stored hash, so changing the password stops
 *   every proof issued under the old one. The link id is in the signed payload
 *   as well as in the cookie's name: the name alone would let one link's proof
 *   be renamed into another's, and two links sharing a password share a stored
 *   hash, so the fingerprint does not tell them apart either.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { MAX_PASSWORD_LENGTH } from '@clickmonk/core'

/** One cookie per link, so a proof for one link is not a proof for another. */
export const PASSWORD_COOKIE_PREFIX = 'cm_pw_'
/** How long a visitor is not asked again. */
export const PASSWORD_PROOF_MS = 12 * 60 * 60 * 1000
/** Wrong answers from one address for one link, per minute. */
export const PASSWORD_ATTEMPT_LIMIT = 5
export const PASSWORD_ATTEMPT_WINDOW_MS = 60_000
/** Password checks in flight in the redirect process. */
export const PASSWORD_CHECKS_IN_FLIGHT = 2
/** The longest form body the gate reads: a password and its field name. */
export const MAX_PASSWORD_BODY_BYTES = 512
const MAX_COOKIE_HEADER = 8192
/** Longer than any proof this mints, short enough that checking one is bounded. */
const MAX_PROOF_VALUE = 128

export const passwordCookieName = (linkId: string): string => `${PASSWORD_COOKIE_PREFIX}${linkId}`

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`cm_pw:${payload}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url')
}

/**
 * The proof cookie. `SameSite=Lax` rather than `Strict`, because a visitor
 * arrives at a link from another site and must not be asked again on that
 * first navigation; `Secure`, so it is never sent in clear, which means the
 * gate works only over HTTPS — a plain-HTTP trial asks every time.
 */
export function passwordProofCookie(o: {
  linkId: string
  fingerprint: string
  nowMs: number
  secret: string
}): string {
  const expires = o.nowMs + PASSWORD_PROOF_MS
  const payload = `${o.linkId}.${o.fingerprint}.${expires}`
  const maxAge = Math.floor(PASSWORD_PROOF_MS / 1000)
  return `${passwordCookieName(o.linkId)}=${expires}.${sign(payload, o.secret)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.slice(0, MAX_COOKIE_HEADER).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    if (key === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Whether this visitor has already answered this link's password. False for a
 * missing, malformed, forged or expired cookie, and for one issued under a
 * different password.
 */
export function hasPasswordProof(o: {
  cookieHeader: string | undefined
  linkId: string
  fingerprint: string
  nowMs: number
  secret: string
}): boolean {
  const value = cookieValue(o.cookieHeader, passwordCookieName(o.linkId))
  if (!value || value.length > MAX_PROOF_VALUE) return false
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return false
  const expiresText = value.slice(0, dot)
  if (!/^\d{1,15}$/.test(expiresText)) return false
  const expires = Number(expiresText)
  const want = Buffer.from(sign(`${o.linkId}.${o.fingerprint}.${expires}`, o.secret), 'base64url')
  const given = Buffer.from(value.slice(dot + 1), 'base64url')
  // The length check is in front of the comparison because timingSafeEqual
  // throws on a length mismatch, and a cookie is whatever the browser sent.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false
  return expires > o.nowMs
}

/** The password a form body carries, or null. Bounded, and never logged. */
export function passwordFromBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>).password
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSWORD_LENGTH) {
    return null
  }
  return value
}

/**
 * The page, which is the same page every time. It takes no value from the
 * request — the form posts back to the URL the browser is already on — so
 * there is nothing here for anything to be reflected into.
 */
export function passwordPage(o: { wrong: boolean } = { wrong: false }): string {
  const message = o.wrong
    ? '<p class="e">That password is not right.</p>'
    : '<p class="h">This link is password protected.</p>'
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Password required</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; min-height: 100vh; place-items: center; }
  form { display: grid; gap: .75rem; width: min(22rem, 90vw); }
  input, button { font: inherit; padding: .6rem .7rem; }
  .e { color: #a3161b; }
  .h, .e { margin: 0; }
</style>
<form method="post" action="">
  ${message}
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus required maxlength="${MAX_PASSWORD_LENGTH}">
  <button type="submit">Continue</button>
</form>
</html>
`
}

function plainPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<p>${message}</p>
</html>
`
}

/** The page shown when an address has answered wrongly too many times. */
export function tooManyAttemptsPage(): string {
  return plainPage('Too many attempts', 'Too many attempts. Wait a minute and try again.')
}

/**
 * The page shown when the process is already checking as many passwords as it
 * will check at once. Its own words, not the attempt limiter's: this is the
 * server's state and not the visitor's doing, it can happen on a first attempt,
 * and telling someone they have tried too often beside a `Retry-After: 1` is
 * both a lie and a contradiction of the header next to it.
 */
export function serverBusyPage(): string {
  return plainPage('Busy', 'The server is busy. Try again in a moment.')
}
