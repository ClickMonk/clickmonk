import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const MAX_SEEN = 40
const MAX_COOKIE_HEADER = 8192
const ONE_YEAR = 31_536_000
const VID_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface Visitor {
  id: string
  isNew: boolean
  /** Link IDs this visitor has been sent on from, most recent first. */
  seen: string[]
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.slice(0, MAX_COOKIE_HEADER).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return out
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`cm_seen:${payload}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url')
}

function readSeen(value: string | undefined, secret: string): string[] {
  if (!value) return []
  const dot = value.lastIndexOf('.')
  if (dot === -1) return []
  const payload = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1), 'base64url')
  const want = Buffer.from(sign(payload, secret), 'base64url')
  if (given.length !== want.length || !timingSafeEqual(given, want)) return []
  const ids = Buffer.from(payload, 'base64url').toString('utf8').split(',')
  return ids.filter((id) => UUID_RE.test(id)).slice(0, MAX_SEEN)
}

export function readVisitor(cookieHeader: string | undefined, secret: string): Visitor {
  const cookies = parseCookies(cookieHeader)
  const vid = cookies.get('cm_vid')
  if (vid && VID_RE.test(vid)) {
    return { id: vid, isNew: false, seen: readSeen(cookies.get('cm_seen'), secret) }
  }
  return { id: randomBytes(16).toString('base64url'), isNew: true, seen: [] }
}

const ATTRS = `; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; Secure; SameSite=Lax`

/** Set-Cookie values. `seenLinkId` is the link this click was sent on from, if any. */
export function visitorCookies(v: Visitor, seenLinkId: string | null, secret: string): string[] {
  const out = [`cm_vid=${v.id}${ATTRS}`]
  if (seenLinkId) {
    const seen = [seenLinkId, ...v.seen.filter((id) => id !== seenLinkId)].slice(0, MAX_SEEN)
    const payload = Buffer.from(seen.join(','), 'utf8').toString('base64url')
    out.push(`cm_seen=${payload}.${sign(payload, secret)}${ATTRS}`)
  }
  return out
}
