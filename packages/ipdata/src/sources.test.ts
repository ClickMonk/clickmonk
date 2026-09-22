import { describe, expect, it } from 'vitest'
import { parseIp } from './ip.js'
import {
  SOURCES,
  SOURCE_IDS,
  SourceError,
  checkMinimum,
  parseBadAsnList,
  parseDbIpAsn,
  parseDbIpCountry,
  parseOnionoo,
} from './sources.js'
import { packCountry } from './table.js'

// Every fixture below is made up, from the documentation address ranges.
const LIMITS = { max32: 100, max128: 100 }
const n4 = (s: string) => (parseIp(s) as { n: number }).n
const w6 = (s: string) => (parseIp(s) as { w: readonly [number, number, number, number] }).w

describe('parseDbIpCountry', () => {
  const csv = [
    '192.0.2.0,192.0.2.255,DE',
    '198.51.100.0,198.51.100.255,ZZ',
    '203.0.113.0,203.0.113.255,FR',
    '2001:db8::,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,NL',
    '',
  ].join('\n')

  it('reads IPv4 and IPv6 ranges, and skips the unassigned code ZZ', () => {
    const t = parseDbIpCountry(csv, LIMITS)
    expect(t.size).toEqual({ k32: 2, k128: 1 })
    expect(t.get32(n4('192.0.2.7'))).toBe(packCountry('DE'))
    expect(t.get32(n4('198.51.100.7'))).toBeNull()
    expect(t.get128(w6('2001:db8::7'))).toBe(packCountry('NL'))
  })

  it.each([
    ['a line with two fields', '192.0.2.0,192.0.2.255'],
    ['a lower-case code', '192.0.2.0,192.0.2.255,de'],
    ['a bad address', '192.0.2.0,192.0.2.300,DE'],
    ['a range of mixed families', '192.0.2.0,2001:db8::1,DE'],
  ])('refuses %s, naming the line', (_label, bad) => {
    expect(() => parseDbIpCountry(`192.0.2.0,192.0.2.1,DE\n${bad}\n`, LIMITS)).toThrow(/line 2/)
  })

  it('stops at the bound rather than reading on', () => {
    expect(() => parseDbIpCountry(csv, { max32: 1, max128: 100 })).toThrow(SourceError)
  })
})

describe('parseDbIpAsn', () => {
  it('reads the ASN and ignores the quoted organisation, commas and all', () => {
    const t = parseDbIpAsn(
      [
        '192.0.2.0,192.0.2.255,64500,"Example Networks, Inc."',
        '198.51.100.0,198.51.100.255,64501,Example Hosting',
        '203.0.113.0,203.0.113.255,0,"Not routed"',
        '2001:db8::,2001:db8::ffff,4200000000,"Example, v6"',
      ].join('\n'),
      LIMITS,
    )
    expect(t.get32(n4('192.0.2.1'))).toBe(64500)
    expect(t.get32(n4('198.51.100.1'))).toBe(64501)
    expect(t.get32(n4('203.0.113.1'))).toBeNull()
    expect(t.get128(w6('2001:db8::1'))).toBe(4_200_000_000)
  })

  it('refuses an ASN that is not a number or does not fit 32 bits', () => {
    expect(() => parseDbIpAsn('192.0.2.0,192.0.2.255,AS64500,x', LIMITS)).toThrow(/line 1/)
    expect(() => parseDbIpAsn('192.0.2.0,192.0.2.255,4294967296,x', LIMITS)).toThrow(/line 1/)
  })
})

describe('parseBadAsnList', () => {
  it('reads one ASN per line after the header, quoted or not, once each', () => {
    const t = parseBadAsnList(
      'ASN,Entity\n64500,"Example Hosting, Ltd"\n"64501",Example\n64500,dup\n',
      LIMITS,
    )
    expect(t.size.k32).toBe(2)
    expect(t.get32(64500)).toBe(1)
    expect(t.get32(64501)).toBe(1)
    expect(t.get32(64502)).toBeNull()
  })

  it('refuses a line that does not start with an ASN', () => {
    expect(() => parseBadAsnList('ASN,Entity\nhosting,64500\n', LIMITS)).toThrow(/line 2/)
  })
})

describe('parseOnionoo', () => {
  const doc = JSON.stringify({
    version: '8.0',
    relays: [
      { or_addresses: ['192.0.2.10:443', '[2001:db8::10]:9001'], exit_addresses: ['192.0.2.11'] },
      { or_addresses: ['192.0.2.10:9001'] },
      { exit_addresses: ['198.51.100.20'] },
    ],
  })

  it('collects exit and onion-routing addresses, without ports, once each', () => {
    const t = parseOnionoo(doc, LIMITS)
    expect(t.size).toEqual({ k32: 3, k128: 1 })
    for (const ip of ['192.0.2.10', '192.0.2.11', '198.51.100.20']) expect(t.get32(n4(ip))).toBe(1)
    expect(t.get128(w6('2001:db8::10'))).toBe(1)
    expect(t.get32(n4('192.0.2.12'))).toBeNull()
  })

  it('refuses a document that is not what Onionoo sends', () => {
    expect(() => parseOnionoo('<html>', LIMITS)).toThrow(/not JSON/)
    expect(() => parseOnionoo('{}', LIMITS)).toThrow(/no relays/)
    expect(() => parseOnionoo('{"relays":[{"exit_addresses":["nope"]}]}', LIMITS)).toThrow(
      /not an address/,
    )
  })
})

describe('checkMinimum', () => {
  const t = parseDbIpCountry('192.0.2.0,192.0.2.255,DE\n2001:db8::,2001:db8::ff,NL\n', LIMITS)

  it('passes a table at the minimum', () => {
    expect(() => checkMinimum('country', t, { k32: 1, k128: 1, v4Addresses: 256 })).not.toThrow()
  })

  it.each([
    ['too few IPv4 entries', { k32: 2, k128: 1 }],
    ['too few IPv6 entries', { k32: 1, k128: 2 }],
    ['too few IPv4 addresses covered', { k32: 1, k128: 1, v4Addresses: 257 }],
  ])('refuses %s', (_label, minimum) => {
    expect(() => checkMinimum('country', t, minimum)).toThrow(SourceError)
  })
})

describe('SOURCES', () => {
  it('names the DB-IP edition of this month, then of last month', () => {
    const january = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 15))
    const year = january.getUTCFullYear()
    expect(SOURCES.country.candidates(january)).toEqual([
      {
        url: `https://download.db-ip.com/free/dbip-country-lite-${year}-01.csv.gz`,
        version: `${year}-01`,
      },
      {
        url: `https://download.db-ip.com/free/dbip-country-lite-${year - 1}-12.csv.gz`,
        version: `${year - 1}-12`,
      },
    ])
    expect(SOURCES.asn.candidates(january)[0]?.url).toBe(
      `https://download.db-ip.com/free/dbip-asn-lite-${year}-01.csv.gz`,
    )
  })

  it('states a compatible licence and an attribution for every source', () => {
    for (const id of SOURCE_IDS) {
      expect(['CC BY 4.0', 'CC0 1.0', 'MIT']).toContain(SOURCES[id].licence)
      expect(SOURCES[id].attribution.length).toBeGreaterThan(20)
    }
    expect(SOURCES.country.attribution).toContain('https://db-ip.com')
    expect(SOURCES.asn.attribution).toContain('https://db-ip.com')
  })
})
