import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  CLICKMONK_POSTGRES_URL: 'postgres://u:p@db:5432/clickmonk',
  CLICKMONK_SECRET: 's'.repeat(32),
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      port: 8080,
      internalPort: 9091,
      spoolDir: '/var/lib/clickmonk/spool',
      spoolMaxBytes: 5_368_709_120,
      snapshotPath: '/var/lib/clickmonk/state/snapshot.json',
      trustedProxies: ['127.0.0.1'],
      ipdataDir: '/var/lib/clickmonk/ipdata',
    })
  })

  it('names every missing or bad variable at once', () => {
    expect(() => loadConfig({ CLICKMONK_SECRET: 'short' })).toThrow(
      /CLICKMONK_POSTGRES_URL[\s\S]*CLICKMONK_SECRET/,
    )
  })

  it('splits trusted proxies', () => {
    expect(
      loadConfig({ ...base, CLICKMONK_TRUSTED_PROXIES: '10.0.0.0/8, 172.16.0.0/12' })
        .trustedProxies,
    ).toEqual(['10.0.0.0/8', '172.16.0.0/12'])
  })

  it.each([
    ['a range', '198.51.100.0/24', ['198.51.100.0/24']],
    ['an IPv6 range', '2001:db8::/32', ['2001:db8::/32']],
    ['an address', '192.0.2.10', ['192.0.2.10']],
    ['a named range', 'loopback', ['loopback']],
    ['a list', 'loopback, 203.0.113.10', ['loopback', '203.0.113.10']],
  ])('accepts %s as a trusted proxy', (_label, value, want) => {
    expect(loadConfig({ ...base, CLICKMONK_TRUSTED_PROXIES: value }).trustedProxies).toEqual(want)
  })

  it.each([
    ['every IPv4 address', '0.0.0.0/0'],
    ['every IPv6 address', '::/0'],
    ['something that is not an address', 'proxy.example.test'],
    ['a prefix longer than the address', '192.0.2.0/33'],
    ['one bad entry in a list', '192.0.2.10, nonsense'],
  ])('refuses %s as a trusted proxy, naming the variable', (_label, value) => {
    expect(() => loadConfig({ ...base, CLICKMONK_TRUSTED_PROXIES: value })).toThrow(
      /invalid configuration:\n {2}CLICKMONK_TRUSTED_PROXIES: /,
    )
  })
})
