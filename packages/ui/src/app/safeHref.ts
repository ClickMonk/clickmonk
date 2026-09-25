/**
 * A URL from a response, as an `href`, only when it is plainly a web address.
 * The service already refuses anything else on the way in; this does not rely
 * on that, because a link is the one place a stored string becomes something
 * the browser acts on.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}
