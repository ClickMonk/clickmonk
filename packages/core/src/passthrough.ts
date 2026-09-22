export const MAX_PASSTHROUGH_PARAMS = 50
export const MAX_DESTINATION_LENGTH = 4096

function encodePair(k: string, v: string): string {
  return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
}

/**
 * Appends the visitor's query parameters to the destination. A parameter the
 * destination already sets is never overwritten: the destination is what the
 * admin configured, and a visitor-supplied value must not replace an
 * affiliate ID. At most 50 incoming parameters are considered, and a
 * parameter that would take the URL past `maxLength` is skipped.
 *
 * Built by string concatenation, not by URL.searchParams, so the
 * destination's own query is kept byte for byte as the admin wrote it.
 */
export function applyPassthrough(
  destination: string,
  incoming: URLSearchParams,
  maxLength = MAX_DESTINATION_LENGTH,
): string {
  const hashAt = destination.indexOf('#')
  const base = hashAt === -1 ? destination : destination.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : destination.slice(hashAt)
  const queryAt = base.indexOf('?')
  const existing = new URLSearchParams(queryAt === -1 ? '' : base.slice(queryAt + 1))

  let out = base
  let sep = queryAt === -1 ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&'
  let considered = 0
  for (const [k, v] of incoming) {
    if (considered >= MAX_PASSTHROUGH_PARAMS) break
    considered++
    if (existing.has(k)) continue
    const pair = encodePair(k, v)
    if (out.length + sep.length + pair.length + fragment.length > maxLength) continue
    out += sep + pair
    sep = '&'
  }
  return out + fragment
}
