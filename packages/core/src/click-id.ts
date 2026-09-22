/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then randomness, so IDs
 * sort by creation time and fit ClickHouse's UUID type. Uses Web Crypto, which
 * Node exposes globally, so this module stays free of node: imports.
 */
export function uuidv7(
  nowMs: number = Date.now(),
  random: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(10)),
): string {
  const b = new Uint8Array(16)
  let t = BigInt(nowMs)
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn)
    t >>= 8n
  }
  b.set(random.subarray(0, 10), 6)
  b[6] = ((b[6] as number) & 0x0f) | 0x70
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
