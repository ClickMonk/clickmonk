import {
  LINK_SCRYPT,
  MAX_PASSWORD_LENGTH,
  hashPassword,
  passwordFingerprint,
  verifyPassword,
} from '@clickmonk/core'
import { describe, expect, it } from 'vitest'
import {
  MAX_PASSWORD_BODY_BYTES,
  PASSWORD_CHECKS_IN_FLIGHT,
  PASSWORD_PROOF_MS,
  hasPasswordProof,
  passwordCookieName,
  passwordFromBody,
  passwordPage,
  passwordProofCookie,
  serverBusyPage,
  tooManyAttemptsPage,
} from './password.js'
import { UNREADABLE_PASSWORD_HASH } from './snapshot.js'

const SECRET = 'test-secret-that-is-long-enough-000000'
const LINK = '00000000-0000-4000-8000-0000000000a1'
const OTHER_LINK = '00000000-0000-4000-8000-0000000000a2'
/**
 * Derived, never a literal: no `scrypt$…` string is committed anywhere. Nothing
 * here verifies against it — `passwordFingerprint` takes any string — so the
 * cost is the cheap one.
 */
const HASH = await hashPassword('spring2026', LINK_SCRYPT)
const FINGERPRINT = passwordFingerprint(HASH)
const NOW = 1_700_000_000_000

/** The `Cookie` header a browser would send back for a proof cookie. */
function asCookieHeader(setCookie: string): string {
  return setCookie.split(';')[0] as string
}

const proof = (over: { linkId?: string; fingerprint?: string; nowMs?: number } = {}): string =>
  asCookieHeader(
    passwordProofCookie({
      linkId: over.linkId ?? LINK,
      fingerprint: over.fingerprint ?? FINGERPRINT,
      nowMs: over.nowMs ?? NOW,
      secret: SECRET,
    }),
  )

describe('the proof cookie', () => {
  it('is per link, HttpOnly, Secure and SameSite=Lax', () => {
    const cookie = passwordProofCookie({
      linkId: LINK,
      fingerprint: FINGERPRINT,
      nowMs: NOW,
      secret: SECRET,
    })
    const [pair, ...attributes] = cookie.split('; ')
    expect((pair as string).startsWith(`${passwordCookieName(LINK)}=`)).toBe(true)
    // The whole attribute list, in order: an attribute dropped fails here, and
    // so does one added that nothing decided to add.
    expect(attributes).toEqual(['Path=/', 'Max-Age=43200', 'HttpOnly', 'Secure', 'SameSite=Lax'])
    expect(PASSWORD_PROOF_MS).toBe(43_200_000)
  })

  it('carries an expiry and a signature, and nothing else at all', () => {
    const cookie = passwordProofCookie({
      linkId: LINK,
      fingerprint: FINGERPRINT,
      nowMs: NOW,
      secret: SECRET,
    })
    const value = asCookieHeader(cookie).slice(`${passwordCookieName(LINK)}=`.length)
    // The whole value, pinned by shape: 13 digits of expiry and 16 bytes of
    // HMAC as base64url. Nothing derived from the password can ride along in
    // it, because there is no room in it for anything to.
    expect(value).toMatch(/^\d{13}\.[A-Za-z0-9_-]{22}$/)
    expect(cookie).not.toContain('scrypt')
    expect(cookie).not.toContain(HASH)
    // Not even the fingerprint, which is signed over but never sent.
    expect(cookie).not.toContain(FINGERPRINT)
  })

  const check = (
    cookieHeader: string | undefined,
    over: Partial<{ nowMs: number; fingerprint: string; linkId: string }> = {},
  ) =>
    hasPasswordProof({
      cookieHeader,
      linkId: over.linkId ?? LINK,
      fingerprint: over.fingerprint ?? FINGERPRINT,
      nowMs: over.nowMs ?? NOW,
      secret: SECRET,
    })

  it('verifies the link it was issued for, and nothing else', () => {
    expect(check(proof())).toBe(true)
    expect(check(proof({ linkId: OTHER_LINK }))).toBe(false)
    expect(check(proof(), { linkId: OTHER_LINK })).toBe(false)
    // The cookie name is per link, so the two above never meet the signature
    // at all. This one does: the same proof relabelled as the other link's
    // cookie, presented for that link. The link id is in the signed payload
    // too, so relabelling does not carry a proof across links — without that,
    // one link's proof opens another's by a rename in the browser.
    const relabelled = proof().replace(passwordCookieName(LINK), passwordCookieName(OTHER_LINK))
    expect(relabelled.startsWith(`${passwordCookieName(OTHER_LINK)}=`)).toBe(true)
    expect(check(relabelled, { linkId: OTHER_LINK })).toBe(false)
  })

  // Changing a link's password changes its hash, so the fingerprint the proof
  // was signed over no longer matches: every proof issued under the old
  // password stops working, which is the whole point of binding to it.
  it('stops verifying once the password changed', () => {
    const cookie = proof()
    expect(check(cookie)).toBe(true)
    expect(check(cookie, { fingerprint: passwordFingerprint(`${HASH}x`) })).toBe(false)
  })

  it('expires', () => {
    const cookie = proof()
    expect(check(cookie, { nowMs: NOW + PASSWORD_PROOF_MS - 1 })).toBe(true)
    expect(check(cookie, { nowMs: NOW + PASSWORD_PROOF_MS })).toBe(false)
  })

  it('refuses a forged or mangled cookie', () => {
    const good = proof()
    const [name, value] = good.split('=') as [string, string]
    const [expires, signature] = value.split('.') as [string, string]
    for (const [label, header] of [
      ['no cookie', undefined],
      ['no signature', `${name}=${expires}`],
      ['another signature', `${name}=${expires}.${'a'.repeat(signature.length)}`],
      ['a truncated signature', `${name}=${expires}.${signature.slice(0, -1)}`],
      ['a later expiry with the old signature', `${name}=${Number(expires) + 1}.${signature}`],
      ['an expiry that is not a number', `${name}=soon.${signature}`],
      ['an empty value', `${name}=`],
      ['a huge value', `${name}=${'a'.repeat(400)}`],
      ['another link’s cookie name', `${passwordCookieName(OTHER_LINK)}=${value}`],
    ] as [string, string | undefined][]) {
      expect(check(header), label).toBe(false)
    }
  })

  it('finds its cookie among others', () => {
    const cookie = proof()
    expect(check(`cm_vid=abc; ${cookie}; other=1`)).toBe(true)
  })
})

/**
 * The one thing standing between a damaged snapshot file and a proof cookie
 * for every link in it.
 *
 * A file whose password hash is not a string becomes the sentinel, and the
 * link stays locked *because* no verifier parses the sentinel — not because
 * anything downstream recognises it. `passwordFingerprint` of it is an
 * ordinary-looking fingerprint, so the cookie would be minted and would
 * verify; the refusal below is the whole of the defence. A verifier that read
 * an unparsable stored hash as "no password" would turn the sentinel into a
 * ten-character password on every damaged link.
 */
describe('the unreadable-hash sentinel', () => {
  it('is refused by the verifier, whatever is offered against it', async () => {
    for (const password of [
      'spring2026',
      UNREADABLE_PASSWORD_HASH,
      ' ',
      'x'.repeat(MAX_PASSWORD_LENGTH),
    ]) {
      expect(await verifyPassword(password, UNREADABLE_PASSWORD_HASH), password).toBe(false)
    }
    // The real hash still verifies, so the case above is the sentinel being
    // refused rather than the verifier refusing everything.
    expect(await verifyPassword('spring2026', HASH)).toBe(true)
  })

  it('fingerprints like any other stored value, which is why the verifier has to refuse it', () => {
    // Nothing about the fingerprint marks it as damaged: a proof cookie signed
    // over it is a perfectly valid proof cookie.
    expect(passwordFingerprint(UNREADABLE_PASSWORD_HASH)).toMatch(/^[0-9a-f]{16}$/)
    const cookie = proof({ fingerprint: passwordFingerprint(UNREADABLE_PASSWORD_HASH) })
    expect(
      hasPasswordProof({
        cookieHeader: cookie,
        linkId: LINK,
        fingerprint: passwordFingerprint(UNREADABLE_PASSWORD_HASH),
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toBe(true)
  })
})

describe('the form body', () => {
  it('takes a password, bounded, and nothing else', () => {
    expect(passwordFromBody({ password: 'spring2026' })).toBe('spring2026')
    expect(passwordFromBody({ password: '' })).toBeNull()
    // The bound itself, from both sides. The length is written out rather than
    // taken from the constant on both sides of the assertion: two values built
    // from the same constant agree with each other however it changes, so a
    // bound quietly shrunk to ten would have passed.
    const atBound = 'x'.repeat(200)
    expect(MAX_PASSWORD_LENGTH).toBe(200)
    expect(passwordFromBody({ password: atBound })).toBe(atBound)
    expect(passwordFromBody({ password: `${atBound}x` })).toBeNull()
    expect(passwordFromBody({})).toBeNull()
    expect(passwordFromBody(null)).toBeNull()
    expect(passwordFromBody('password=x')).toBeNull()
    expect(passwordFromBody({ password: 12 })).toBeNull()
    // Nothing inherited counts: a body carrying only a prototype key has no
    // password of its own.
    expect(passwordFromBody(JSON.parse('{"__proto__":{"password":"x"}}'))).toBeNull()
  })

  it('bounds what one process will check at once', () => {
    // Only observable otherwise by a burst timed against a scrypt pass, which
    // is not a test this suite can hold still.
    expect(PASSWORD_CHECKS_IN_FLIGHT).toBe(2)
  })

  it('bounds the body well inside what a password can need', () => {
    expect(MAX_PASSWORD_BODY_BYTES).toBeGreaterThan(
      `password=${'x'.repeat(MAX_PASSWORD_LENGTH)}`.length,
    )
  })
})

describe('the pages beside it', () => {
  it('say different things, so neither stands in for the other', () => {
    // One is about this visitor's attempts, the other about the process being
    // busy; a first attempt can meet the second, and being told it has tried
    // too often would be false.
    expect(tooManyAttemptsPage()).toContain('Too many attempts.')
    expect(serverBusyPage()).toContain('The server is busy.')
    expect(serverBusyPage()).not.toContain('Too many attempts')
    expect(serverBusyPage()).not.toContain('Wait a minute')
    for (const page of [tooManyAttemptsPage(), serverBusyPage()]) {
      expect(page).toContain('noindex')
      expect(page).not.toContain('name="password"')
    }
  })
})

describe('the page', () => {
  it('asks once, says nothing about the password, and is not indexed', () => {
    const page = passwordPage()
    expect(page).toContain('name="password"')
    expect(page).toContain('noindex')
    expect(page).toContain('This link is password protected.')
    expect(page).not.toContain('not right')
  })

  it('says a password was wrong without saying anything else about it', () => {
    const page = passwordPage({ wrong: true })
    expect(page).toContain('That password is not right.')
    // The form posts back to the URL the browser is on, so there is nothing
    // from the request in the page to reflect.
    expect(page).toContain('action=""')
    expect(page).not.toContain('This link is password protected.')
  })

  it('is the same page either way apart from the one line', () => {
    // The oracle test: a visitor who has answered wrongly can learn that, and
    // nothing else. Swapping the one line back gives the first page exactly —
    // byte for byte, so a second difference anywhere fails here.
    const swapped = passwordPage({ wrong: true }).replace(
      '<p class="e">That password is not right.</p>',
      '<p class="h">This link is password protected.</p>',
    )
    expect(swapped).toBe(passwordPage())
  })

  it('never says how many guesses are left', () => {
    // The limiter's own page says to wait; neither password page may hint at
    // where an address stands, or the count is readable off it.
    for (const page of [passwordPage(), passwordPage({ wrong: true })]) {
      expect(page.toLowerCase()).not.toContain('attempt')
      expect(page.toLowerCase()).not.toContain('again')
    }
  })
})
