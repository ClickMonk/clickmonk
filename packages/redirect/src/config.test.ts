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

describe('the admin host', () => {
  it('is null when it is not set, so ask approves verified link domains only', () => {
    expect(loadConfig(base).adminHost).toBeNull()
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_HOST: '' }).adminHost).toBeNull()
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_HOST: ' admin.example.test ' }).adminHost).toBe(
      'admin.example.test',
    )
  })

  // A value with a scheme or a port would match no Host header and no `ask`
  // query, so the install would look configured and quietly have no admin
  // interface. It fails the configuration instead, naming the variable.
  it.each([
    'https://admin.example.test',
    'admin.example.test:443',
    'Admin.Example.Test',
    'not a host',
  ])('refuses %s', (value) => {
    expect(() => loadConfig({ ...base, CLICKMONK_ADMIN_HOST: value })).toThrow(
      /CLICKMONK_ADMIN_HOST/,
    )
  })
})
