import { describe, expect, it } from 'vitest'
import { type Words, parseIp } from './ip.js'
import { type Range32, type Range128, RangeTable, TableError, packCountry } from './table.js'

const LIMITS = { max32: 100, max128: 100 }

const v4 = (s: string): number => {
  const p = parseIp(s)
  if (p?.v !== 4) throw new Error(`not IPv4: ${s}`)
  return p.n
}
const v6 = (s: string): Words => {
  const p = parseIp(s)
  if (p?.v !== 6) throw new Error(`not IPv6: ${s}`)
  return p.w
}

// Documentation ranges only, and every probe below stays inside them: room
// before the first range, a gap between the two, and room after the last.
const r32: Range32[] = [
  { start: v4('198.51.100.0'), end: v4('198.51.100.127'), value: packCountry('FR') },
  { start: v4('192.0.2.16'), end: v4('192.0.2.127'), value: packCountry('DE') },
]
const r128: Range128[] = [
  {
    start: v6('2001:db8:0:1::'),
    end: v6('2001:db8:0:1:ffff:ffff:ffff:ffff'),
    value: packCountry('NL'),
  },
  { start: v6('2001:db8:1::'), end: v6('2001:db8:1::ff'), value: packCountry('BE') },
]
const table = () => RangeTable.build('country', r32, r128, LIMITS)

describe('RangeTable lookups', () => {
  it('finds a key at the first, last and a middle address of a range', () => {
    const t = table()
    for (const ip of ['192.0.2.16', '192.0.2.64', '192.0.2.127']) {
      expect(t.get32(v4(ip))).toBe(packCountry('DE'))
    }
    expect(t.get32(v4('198.51.100.127'))).toBe(packCountry('FR'))
  })

  it('finds nothing in a gap, before the first range or after the last', () => {
    const t = table()
    expect(t.get32(v4('192.0.2.128'))).toBeNull()
    expect(t.get32(v4('192.0.2.15'))).toBeNull()
    expect(t.get32(v4('198.51.100.128'))).toBeNull()
  })

  it('does the same for 128-bit keys', () => {
    const t = table()
    expect(t.get128(v6('2001:db8:0:1::'))).toBe(packCountry('NL'))
    expect(t.get128(v6('2001:db8:0:1:ffff:ffff:ffff:ffff'))).toBe(packCountry('NL'))
    expect(t.get128(v6('2001:db8:1::ff'))).toBe(packCountry('BE'))
    expect(t.get128(v6('2001:db8:1::100'))).toBeNull()
    expect(t.get128(v6('2001:db8::ffff'))).toBeNull()
    expect(t.get128(v6('2001:db8:ffff::'))).toBeNull()
  })

  it('counts the IPv4 addresses its ranges cover', () => {
    // 112 in the first range, 128 in the second; IPv6 ranges do not count.
    expect(table().v4AddressCount()).toBe(240)
  })

  it('answers from an empty table', () => {
    const t = RangeTable.build('tor', [], [], LIMITS)
    expect(t.get32(v4('192.0.2.1'))).toBeNull()
    expect(t.get128(v6('2001:db8::1'))).toBeNull()
  })
})

describe('RangeTable.build', () => {
  it('refuses overlapping ranges', () => {
    const overlap = [
      ...r32,
      { start: v4('192.0.2.100'), end: v4('192.0.2.200'), value: packCountry('DE') },
    ]
    expect(() => RangeTable.build('country', overlap, [], LIMITS)).toThrow(/overlaps/)
    const overlap6 = [
      ...r128,
      { start: v6('2001:db8:1::80'), end: v6('2001:db8:1::1ff'), value: packCountry('BE') },
    ]
    expect(() => RangeTable.build('country', [], overlap6, LIMITS)).toThrow(/overlaps/)
  })

  it('refuses a range that ends before it starts', () => {
    const backwards = [{ start: v4('192.0.2.9'), end: v4('192.0.2.1'), value: packCountry('DE') }]
    expect(() => RangeTable.build('country', backwards, [], LIMITS)).toThrow(/ends before/)
  })

  it('refuses more entries than the bound', () => {
    expect(() => RangeTable.build('country', r32, r128, { max32: 1, max128: 100 })).toThrow(
      TableError,
    )
    expect(() => RangeTable.build('country', r32, r128, { max32: 100, max128: 1 })).toThrow(
      TableError,
    )
  })

  it('refuses a country value that is not two capitals', () => {
    const bad = [{ start: 1, end: 2, value: packCountry('de') }]
    expect(() => RangeTable.build('country', bad, [], LIMITS)).toThrow(/not a country code/)
  })
})

describe('RangeTable.decode', () => {
  it('round-trips, including from an unaligned buffer', () => {
    const bytes = table().encode()
    const back = RangeTable.decode('country', bytes, LIMITS)
    expect(back.get32(v4('192.0.2.20'))).toBe(packCountry('DE'))
    expect(back.get128(v6('2001:db8:1::1'))).toBe(packCountry('BE'))
    const unaligned = new Uint8Array(bytes.length + 1).subarray(1)
    unaligned.set(bytes)
    expect(RangeTable.decode('country', unaligned, LIMITS).get32(v4('198.51.100.1'))).toBe(
      packCountry('FR'),
    )
  })

  it('refuses a file of another kind', () => {
    expect(() => RangeTable.decode('asn', table().encode(), LIMITS)).toThrow(/another kind/)
  })

  it('refuses a truncated file, a foreign file and a file over the bound', () => {
    const bytes = table().encode()
    expect(() => RangeTable.decode('country', bytes.subarray(0, bytes.length - 4), LIMITS)).toThrow(
      /expected/,
    )
    expect(() =>
      RangeTable.decode('country', new TextEncoder().encode('x'.repeat(64)), LIMITS),
    ).toThrow(/not a table file/)
    expect(() => RangeTable.decode('country', bytes, { max32: 1, max128: 100 })).toThrow(
      /over the bound/,
    )
  })

  it('refuses a file whose entries are out of order', () => {
    const bytes = table().encode().slice()
    const words = new Uint32Array(bytes.buffer)
    // The header is 8 words; the two IPv4 starts follow, then the two ends,
    // then the two values. Swap the two entries whole: each is still a valid
    // range, but the second now starts before the first.
    for (const at of [8, 10, 12]) {
      const first = words[at] as number
      words[at] = words[at + 1] as number
      words[at + 1] = first
    }
    expect(() => RangeTable.decode('country', bytes, LIMITS)).toThrow(/out of order/)
  })

  it('refuses a file written in the other byte order', () => {
    const bytes = table().encode().slice()
    new Uint32Array(bytes.buffer)[2] = 0x04030201
    expect(() => RangeTable.decode('country', bytes, LIMITS)).toThrow(/byte order/)
  })
})
