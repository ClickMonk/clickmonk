/** An IPv6 address as four 32-bit words, most significant first. */
export type Words = readonly [number, number, number, number]

export type ParsedIp = { v: 4; n: number } | { v: 6; w: Words }

/** The longest textual IP address: an IPv6 address with an embedded IPv4 one. */
export const MAX_IP_LENGTH = 45

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/

/** Dotted-quad to an unsigned 32-bit number. Leading zeros are refused: some parsers read them as octal. */
function parseV4(s: string): number | null {
  const m = V4.exec(s)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const part = m[i] as string
    if (part.length > 1 && part.startsWith('0')) return null
    const octet = Number(part)
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n
}

function parseGroups(part: string, allowV4Tail: boolean): number[] | null {
  if (part === '') return []
  const out: number[] = []
  const groups = part.split(':')
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] as string
    if (allowV4Tail && i === groups.length - 1 && g.includes('.')) {
      const v4 = parseV4(g)
      if (v4 === null) return null
      out.push(v4 >>> 16, v4 & 0xffff)
      continue
    }
    if (!HEX_GROUP.test(g)) return null
    out.push(Number.parseInt(g, 16))
  }
  return out
}

function parseV6(s: string): Words | null {
  const halves = s.split('::')
  if (halves.length > 2) return null
  let groups: number[]
  if (halves.length === 2) {
    const head = parseGroups(halves[0] as string, false)
    const tail = parseGroups(halves[1] as string, true)
    if (!head || !tail) return null
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail]
  } else {
    const all = parseGroups(s, true)
    if (!all || all.length !== 8) return null
    groups = all
  }
  const g = (i: number) => groups[i] as number
  return [
    ((g(0) << 16) | g(1)) >>> 0,
    ((g(2) << 16) | g(3)) >>> 0,
    ((g(4) << 16) | g(5)) >>> 0,
    ((g(6) << 16) | g(7)) >>> 0,
  ]
}

/**
 * Parses a textual IPv4 or IPv6 address, or returns null. An IPv4-mapped
 * IPv6 address (`::ffff:192.0.2.1`) is returned as the IPv4 address it
 * carries, so it finds the same entry. Zone IDs (`2001:db8::1%eth0`) are
 * refused: no public client address carries one.
 */
export function parseIp(s: string): ParsedIp | null {
  if (s.length === 0 || s.length > MAX_IP_LENGTH) return null
  if (!s.includes(':')) {
    const n = parseV4(s)
    return n === null ? null : { v: 4, n }
  }
  const w = parseV6(s)
  if (!w) return null
  if (w[0] === 0 && w[1] === 0 && w[2] === 0xffff) return { v: 4, n: w[3] }
  return { v: 6, w }
}

/**
 * The address alone, from the forms a proxy or a relay list names one in:
 * `[2001:db8::5]:443` and `[2001:db8::5]` lose their brackets and port,
 * `203.0.113.5:443` its port. An unbracketed string with more than one colon
 * is an IPv6 address (`::ffff:192.0.2.1` included) and is returned
 * unchanged, as is a `[` never closed: `parseIp` refuses what is still not an
 * address. Never throws.
 */
export function addressOnly(s: string): string {
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    return close < 0 ? s : s.slice(1, close)
  }
  const colon = s.indexOf(':')
  return colon >= 0 && colon === s.lastIndexOf(':') ? s.slice(0, colon) : s
}

/** An IPv6 address in its RFC 5952 text form: lower case, no leading zeros, the longest run of two or more zero groups as `::`. */
function formatV6(w: Words): string {
  const groups = w.flatMap((x) => [x >>> 16, x & 0xffff])
  let best = -1
  let bestLen = 1
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = (a: number[]) => a.map((g) => g.toString(16)).join(':')
  if (best < 0) return hex(groups)
  return `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLen))}`
}

/**
 * One text form per address, so that one visitor is recorded under one
 * string: an IPv4-mapped IPv6 address as the IPv4 address it carries, and
 * IPv6 in its RFC 5952 form. A string that is not an address is returned
 * unchanged.
 */
export function canonicalIp(s: string): string {
  const p = parseIp(s)
  if (!p) return s
  if (p.v === 4) return [p.n >>> 24, (p.n >>> 16) & 0xff, (p.n >>> 8) & 0xff, p.n & 0xff].join('.')
  return formatV6(p.w)
}

/**
 * The key a limiter counts an address under. An IPv6 client usually holds a
 * whole /64 and can pick a new address from it for every request, so IPv6 is
 * counted per /64 and IPv4 per address. Null for a string that is not an
 * address, which leaves the caller to decide what an unreadable address costs.
 *
 * Here rather than in either service because both count by it and they have to
 * agree: the redirect's click rate and link password attempts, and the admin
 * sign-in limiter. It lives beside `parseIp` because that is the parser it is
 * made of, and the family tag on the front is what keeps the two families in
 * separate namespaces — an IPv4 key is one decimal number, an IPv6 key always
 * carries a colon, so no address of one family can ever land on another's key.
 */
export function rateKey(ip: string): string | null {
  const p = parseIp(ip)
  if (!p) return null
  return p.v === 4 ? `4:${p.n}` : `6:${p.w[0]}:${p.w[1]}`
}

/**
 * The network an address belongs to, as text: /24 for IPv4 and /64 for IPv6.
 *
 * Every address this install shows anybody goes through here — the click log
 * and the CSV export — so that an operator can see a pattern or a bot without
 * the file being a file of addresses. The raw column keeps the whole address
 * until the retention pass blanks it, because classification and the abuser
 * counter need it; nothing reads it back out.
 *
 * It is one function rather than a rule written once in each reader, and it is
 * here rather than in either service, for the same reason `rateKey` is: two
 * readers that disagree about the same click are worse than either answer.
 *
 * **Null, never the input, for anything that is not an address.** `canonicalIp`
 * next door returns what it was given when it cannot parse it, which is right
 * for a canonicaliser and would be exactly wrong here: it would hand back the
 * whole address the moment the parser stopped recognising a form it used to
 * accept. A reader has to have an answer for null regardless of that: the
 * retention pass blanks the address column to an empty string, so a click old
 * enough to have been blanked arrives here as something that is not an address.
 */
export function truncateIp(s: string): string | null {
  const p = parseIp(s)
  if (!p) return null
  if (p.v === 4) return `${[p.n >>> 24, (p.n >>> 16) & 0xff, (p.n >>> 8) & 0xff, 0].join('.')}/24`
  return `${formatV6([p.w[0], p.w[1], 0, 0])}/64`
}
