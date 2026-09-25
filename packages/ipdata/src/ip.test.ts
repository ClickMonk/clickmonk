import { describe, expect, it } from 'vitest'
import { addressOnly, canonicalIp, parseIp, rateKey, truncateIp } from './ip.js'

describe('parseIp', () => {
  it.each([
    ['192.0.2.1', { v: 4, n: 0xc0000201 }],
    ['0.0.0.0', { v: 4, n: 0 }],
    ['255.255.255.255', { v: 4, n: 0xffffffff }],
    ['2001:db8::1', { v: 6, w: [0x20010db8, 0, 0, 1] }],
    ['2001:DB8:0:0:0:0:0:1', { v: 6, w: [0x20010db8, 0, 0, 1] }],
    ['::', { v: 6, w: [0, 0, 0, 0] }],
    ['::1', { v: 6, w: [0, 0, 0, 1] }],
    ['2001:db8::', { v: 6, w: [0x20010db8, 0, 0, 0] }],
    [
      '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
      { v: 6, w: [0x20010db8, 0xffffffff, 0xffffffff, 0xffffffff] },
    ],
    ['2001:db8::192.0.2.1', { v: 6, w: [0x20010db8, 0, 0, 0xc0000201] }],
    ['::ffff:198.51.100.7', { v: 4, n: 0xc6336407 }],
  ])('%s', (s, want) => {
    expect(parseIp(s)).toEqual(want)
  })

  it.each([
    '',
    '192.0.2',
    '192.0.2.256',
    '192.0.2.01',
    '192.0.2.1.5',
    ' 192.0.2.1',
    '2001:db8:::1',
    '2001:db8::1::2',
    '2001:db8:0:0:0:0:0:0:1',
    '2001:db8:0:0:0:0:1',
    '2001:db8::12345',
    '2001:db8::g',
    '2001:db8:0:0:0:0:0::1',
    '2001:db8:0:0:0:0:0:1::2',
    '192.0.2.1::',
    '2001:db8::1%eth0',
    ':1::',
    `2001:db8::${'0:'.repeat(20)}1`,
    'example.com',
  ])('refuses %j', (s) => {
    expect(parseIp(s)).toBeNull()
  })
})

describe('addressOnly', () => {
  it.each([
    ['[2001:db8::5]:443', '2001:db8::5'],
    ['[2001:db8::5]', '2001:db8::5'],
    ['203.0.113.5:443', '203.0.113.5'],
    ['203.0.113.5', '203.0.113.5'],
    ['2001:db8::5', '2001:db8::5'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
    // Unclosed: returned as it is, for parseIp to refuse.
    ['[2001:db8::5', '[2001:db8::5'],
  ])('%s -> %s', (s, want) => {
    expect(addressOnly(s)).toBe(want)
  })
})

describe('canonicalIp', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::FFFF:C633:6407', '198.51.100.7'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:0db8::0001', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['2001:db8::', '2001:db8::'],
    ['::', '::'],
    ['::1', '::1'],
    ['2001:db8::192.0.2.1', '2001:db8::c000:201'],
    // Not an address: returned as it is.
    ['not-an-address', 'not-an-address'],
    ['', ''],
  ])('%s -> %s', (s, want) => {
    expect(canonicalIp(s)).toBe(want)
  })
})

describe('rateKey', () => {
  it('keys IPv4 by address, IPv4-mapped IPv6 as IPv4, and refuses what is not an address', () => {
    expect(rateKey('192.0.2.1')).toBe(rateKey('::ffff:192.0.2.1'))
    expect(rateKey('192.0.2.1')).not.toBe(rateKey('192.0.2.2'))
    expect(rateKey('nope')).toBeNull()
  })

  it('keys every address in one IPv6 /64 the same, and a different /64 differently', () => {
    // The whole point of the function: a client that holds a /64 cannot buy a
    // second allowance by picking another address out of it.
    expect(rateKey('2001:db8::1')).toBe(rateKey('2001:db8::2'))
    expect(rateKey('2001:db8::1')).toBe(rateKey('2001:db8:0:0:ffff:ffff:ffff:ffff'))
    expect(rateKey('2001:db8::1')).not.toBe(rateKey('2001:db8:0:1::1'))
  })

  it('tags the family, so no IPv4 key can ever be an IPv6 key', () => {
    // A companion assertion, and one that cannot be pinned by a mutation on its
    // own: building a colliding pair would need an IPv4 address whose 32-bit
    // value equals an IPv6 address's first 32 bits, and no such pair exists
    // inside the documentation ranges this repository may use. It is kept
    // because the property matters and the tag is what makes it structural —
    // an IPv4 key is one decimal number, an IPv6 key always carries a colon.
    expect(rateKey('192.0.2.1')).toMatch(/^4:\d+$/)
    expect(rateKey('2001:db8::1')).toMatch(/^6:\d+:\d+$/)
  })
})

describe('truncateIp', () => {
  it.each([
    ['198.51.100.77', '198.51.100.0/24'],
    ['198.51.100.0', '198.51.100.0/24'],
    ['198.51.100.255', '198.51.100.0/24'],
    ['192.0.2.1', '192.0.2.0/24'],
    ['203.0.113.254', '203.0.113.0/24'],
  ])('keeps the network and drops the host of %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected)
  })

  it.each([
    ['2001:db8:1234:5678:9abc:def0:1234:5678', '2001:db8:1234:5678::/64'],
    ['2001:db8:1234:5678::', '2001:db8:1234:5678::/64'],
    ['2001:db8::1', '2001:db8::/64'],
    ['::1', '::/64'],
  ])('keeps the first 64 bits of %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected)
  })

  // The address the visitor was recorded under is an IPv4 address, so what
  // comes out is an IPv4 network: one visitor must not appear as two
  // different kinds of thing depending on how a proxy spelled it.
  it('truncates an IPv4-mapped IPv6 address as IPv4', () => {
    expect(truncateIp('::ffff:198.51.100.77')).toBe('198.51.100.0/24')
  })

  // Deliberately unlike canonicalIp, which returns its input unchanged.
  // Returning the input is how a whole address escapes if the parser ever
  // regresses on a form it used to accept, and this function is the only
  // thing between the stored column and a response.
  it.each([
    ['an empty string', ''],
    ['a host name', 'example.test'],
    ['an address with a port', '198.51.100.77:443'],
    ['a zone id', '2001:db8::1%eth0'],
    ['a CIDR', '198.51.100.0/24'],
    ['a sentence', 'not an address at all'],
  ])('answers null for %s rather than handing it back', (_label, value) => {
    expect(truncateIp(value)).toBeNull()
  })

  it('answers null for a string longer than the longest address', () => {
    expect(truncateIp('1'.repeat(46))).toBeNull()
  })
})
