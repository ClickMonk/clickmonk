import type { Words } from './ip.js'

/**
 * What a table maps. `country` and `asn` map IP ranges to a value; `tor`
 * is a set of IP ranges; `datacenter` is a set of ASNs, held as 32-bit keys.
 */
export const TABLE_KINDS = { country: 1, asn: 2, tor: 3, datacenter: 4 } as const
export type TableKind = keyof typeof TABLE_KINDS

export interface Range32 {
  start: number
  end: number
  value: number
}
export interface Range128 {
  start: Words
  end: Words
  value: number
}

/** The most entries a table may hold per key width. Checked on build and on load. */
export interface TableLimits {
  max32: number
  max128: number
}

export class TableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableError'
  }
}

/**
 * The file layout. A 32-byte header, then for 32-bit keys the starts, ends
 * and values (one u32 each per entry), then for 128-bit keys the starts and
 * ends (four u32 each, most significant word first) and values. Words are
 * in the host's byte order; the endianness marker makes a file from a host
 * of the other order fail to load rather than answer wrongly.
 */
const MAGIC = [0x43, 0x4d, 0x52, 0x54] // "CMRT"
const FORMAT_VERSION = 1
const ENDIAN_MARKER = 0x01020304
const HEADER_BYTES = 32

/** The size of a table file holding n32 32-bit and n128 128-bit entries. */
export function tableBytes(n32: number, n128: number): number {
  return HEADER_BYTES + 12 * n32 + 36 * n128
}

/** ISO 3166-1 alpha-2 packed into a value: two ASCII capitals. */
export function packCountry(code: string): number {
  return (code.charCodeAt(0) << 8) | code.charCodeAt(1)
}

export function unpackCountry(value: number): string | null {
  const a = value >>> 8
  const b = value & 0xff
  if (value > 0xffff || a < 65 || a > 90 || b < 65 || b > 90) return null
  return String.fromCharCode(a, b)
}

function cmp128(a: Uint32Array, i: number, b: Words): number {
  for (let k = 0; k < 4; k++) {
    const x = a[i * 4 + k] as number
    const y = b[k] as number
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Compares entry i of a with entry j of b. */
function cmpAt(a: Uint32Array, i: number, b: Uint32Array, j: number): number {
  for (let k = 0; k < 4; k++) {
    const x = a[i * 4 + k] as number
    const y = b[j * 4 + k] as number
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function cmpWords(a: Words, b: Words): number {
  for (let k = 0; k < 4; k++) {
    if (a[k] !== b[k]) return (a[k] as number) < (b[k] as number) ? -1 : 1
  }
  return 0
}

/**
 * An immutable, sorted table of non-overlapping ranges. A lookup is a binary
 * search: at most about 20 comparisons for a million entries, with no
 * allocation and no I/O, so the redirect can make one on every request.
 */
export class RangeTable {
  private constructor(
    readonly kind: TableKind,
    private readonly s32: Uint32Array,
    private readonly e32: Uint32Array,
    private readonly v32: Uint32Array,
    private readonly s128: Uint32Array,
    private readonly e128: Uint32Array,
    private readonly v128: Uint32Array,
  ) {}

  /** Sorts the ranges by start and refuses a range that ends before it starts or overlaps another. */
  static build(kind: TableKind, r32: Range32[], r128: Range128[], limits: TableLimits): RangeTable {
    if (r32.length > limits.max32 || r128.length > limits.max128) {
      throw new TableError(
        `${kind}: ${r32.length} + ${r128.length} entries, over the bound of ${limits.max32} + ${limits.max128}`,
      )
    }
    const a = [...r32].sort((x, y) => x.start - y.start)
    const b = [...r128].sort((x, y) => cmpWords(x.start, y.start))
    const s32 = new Uint32Array(a.length)
    const e32 = new Uint32Array(a.length)
    const v32 = new Uint32Array(a.length)
    a.forEach((r, i) => {
      s32[i] = r.start
      e32[i] = r.end
      v32[i] = r.value
    })
    const s128 = new Uint32Array(b.length * 4)
    const e128 = new Uint32Array(b.length * 4)
    const v128 = new Uint32Array(b.length)
    b.forEach((r, i) => {
      s128.set(r.start, i * 4)
      e128.set(r.end, i * 4)
      v128[i] = r.value
    })
    const t = new RangeTable(kind, s32, e32, v32, s128, e128, v128)
    t.check()
    return t
  }

  /** Reads a table written by `encode`, checking everything `build` checks. Throws TableError. */
  static decode(kind: TableKind, bytes: Uint8Array, limits: TableLimits): RangeTable {
    if (bytes.byteLength < HEADER_BYTES) throw new TableError(`${kind}: file too short`)
    // Typed arrays need 4-byte alignment; a Buffer may start anywhere in its pool.
    const b = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice()
    if (MAGIC.some((m, i) => b[i] !== m)) throw new TableError(`${kind}: not a table file`)
    const h = new Uint32Array(b.buffer, b.byteOffset, HEADER_BYTES / 4)
    if (h[1] !== FORMAT_VERSION) throw new TableError(`${kind}: unknown format ${h[1]}`)
    if (h[2] !== ENDIAN_MARKER)
      throw new TableError(`${kind}: written on a host of the other byte order`)
    if (h[3] !== TABLE_KINDS[kind])
      throw new TableError(`${kind}: the file holds another kind of table`)
    const n32 = h[4] as number
    const n128 = h[5] as number
    if (n32 > limits.max32 || n128 > limits.max128) {
      throw new TableError(
        `${kind}: ${n32} + ${n128} entries, over the bound of ${limits.max32} + ${limits.max128}`,
      )
    }
    const expected = tableBytes(n32, n128)
    if (b.byteLength !== expected) {
      throw new TableError(`${kind}: ${b.byteLength} bytes, expected ${expected}`)
    }
    let off = b.byteOffset + HEADER_BYTES
    const view = (n: number) => {
      const v = new Uint32Array(b.buffer, off, n)
      off += n * 4
      return v
    }
    const t = new RangeTable(
      kind,
      view(n32),
      view(n32),
      view(n32),
      view(n128 * 4),
      view(n128 * 4),
      view(n128),
    )
    t.check()
    return t
  }

  encode(): Uint8Array {
    const n32 = this.s32.length
    const n128 = this.v128.length
    const out = new Uint8Array(tableBytes(n32, n128))
    out.set(MAGIC, 0)
    const words = new Uint32Array(out.buffer)
    words.set([FORMAT_VERSION, ENDIAN_MARKER, TABLE_KINDS[this.kind], n32, n128], 1)
    let at = HEADER_BYTES / 4
    for (const part of [this.s32, this.e32, this.v32, this.s128, this.e128, this.v128]) {
      words.set(part, at)
      at += part.length
    }
    return out
  }

  get size(): { k32: number; k128: number } {
    return { k32: this.s32.length, k128: this.v128.length }
  }

  /** How many 32-bit keys the ranges cover: for an IP table, the IPv4 addresses. */
  v4AddressCount(): number {
    let n = 0
    for (let i = 0; i < this.s32.length; i++)
      n += (this.e32[i] as number) - (this.s32[i] as number) + 1
    return n
  }

  get byteLength(): number {
    return tableBytes(this.s32.length, this.v128.length)
  }

  /** The value of the range holding `key`, or null. */
  get32(key: number): number | null {
    const s = this.s32
    let lo = 0
    let hi = s.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if ((s[mid] as number) <= key) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found < 0 || (this.e32[found] as number) < key) return null
    return this.v32[found] as number
  }

  /** The value of the range holding `key`, or null. */
  get128(key: Words): number | null {
    let lo = 0
    let hi = this.v128.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (cmp128(this.s128, mid, key) <= 0) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found < 0 || cmp128(this.e128, found, key) < 0) return null
    return this.v128[found] as number
  }

  /** Every range starts at or before its end, after the previous one's end; country values are two capitals. */
  private check(): void {
    for (let i = 0; i < this.s32.length; i++) {
      const s = this.s32[i] as number
      if (s > (this.e32[i] as number))
        throw new TableError(`${this.kind}: entry ${i} ends before it starts`)
      if (i > 0 && s <= (this.e32[i - 1] as number)) {
        throw new TableError(`${this.kind}: entry ${i} overlaps or is out of order`)
      }
    }
    for (let i = 0; i < this.v128.length; i++) {
      if (cmpAt(this.e128, i, this.s128, i) < 0) {
        throw new TableError(`${this.kind}: entry ${i} ends before it starts`)
      }
      if (i > 0 && cmpAt(this.e128, i - 1, this.s128, i) >= 0) {
        throw new TableError(`${this.kind}: entry ${i} overlaps or is out of order`)
      }
    }
    if (this.kind === 'country') {
      for (const values of [this.v32, this.v128]) {
        for (const v of values) {
          if (unpackCountry(v) === null)
            throw new TableError(`country: value ${v} is not a country code`)
        }
      }
    }
  }
}
