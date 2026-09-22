import { describe, expect, it } from 'vitest'
import { addressOnly, parseIp } from './ip.js'

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
