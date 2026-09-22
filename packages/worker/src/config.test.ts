import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  CLICKMONK_POSTGRES_URL: 'postgres://u:p@db:5432/clickmonk',
  CLICKMONK_CLICKHOUSE_URL: 'http://clickhouse:8123',
  CLICKMONK_CLICKHOUSE_USER: 'clickmonk',
  CLICKMONK_CLICKHOUSE_PASSWORD: 'secret',
  CLICKMONK_CLICKHOUSE_DB: 'clickmonk',
}

describe('loadConfig', () => {
  it('reads the stores and defaults the spool and IP data settings', () => {
    expect(loadConfig(base)).toMatchObject({
      spoolDir: '/var/lib/clickmonk/spool',
      ch: { database: 'clickmonk' },
      ipdataDir: '/var/lib/clickmonk/ipdata',
      ipdataUpdate: true,
    })
  })

  it('turns IP data downloads off, and refuses any value but on or off', () => {
    expect(loadConfig({ ...base, CLICKMONK_IPDATA_UPDATE: 'off' }).ipdataUpdate).toBe(false)
    expect(() => loadConfig({ ...base, CLICKMONK_IPDATA_UPDATE: 'no' })).toThrow(
      /CLICKMONK_IPDATA_UPDATE/,
    )
  })

  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/CLICKMONK_POSTGRES_URL[\s\S]*CLICKMONK_CLICKHOUSE_URL/)
  })

  it('checks domain DNS by default, on the host’s own resolvers', () => {
    expect(loadConfig(base)).toMatchObject({
      dnsCheck: true,
      dnsCheckIntervalMs: 300_000,
      dnsServers: [],
    })
  })

  it('takes resolvers with and without a port, and refuses anything else', () => {
    expect(
      loadConfig({ ...base, CLICKMONK_DNS_SERVERS: '192.0.2.1, [2001:db8::1]:5353 ' }).dnsServers,
    ).toEqual(['192.0.2.1', '[2001:db8::1]:5353'])
    expect(() => loadConfig({ ...base, CLICKMONK_DNS_SERVERS: 'dns.example.test' })).toThrow(
      /CLICKMONK_DNS_SERVERS/,
    )
    expect(() => loadConfig({ ...base, CLICKMONK_DNS_SERVERS: '[2001:db8::1]:99999' })).toThrow(
      /CLICKMONK_DNS_SERVERS/,
    )
    // Not a near miss: `2001:db8::1:5353` is not an address and a port, it is
    // a perfectly good address whose last group happens to be 5353. Nothing
    // can tell the two apart, which is why the bracketed form is the only one
    // that carries a port.
    expect(loadConfig({ ...base, CLICKMONK_DNS_SERVERS: '2001:db8::1:5353' }).dnsServers).toEqual([
      '2001:db8::1:5353',
    ])
  })

  it('turns the checks off, and refuses any value but on or off', () => {
    expect(loadConfig({ ...base, CLICKMONK_DNS_CHECK: 'off' }).dnsCheck).toBe(false)
    expect(() => loadConfig({ ...base, CLICKMONK_DNS_CHECK: 'no' })).toThrow(/CLICKMONK_DNS_CHECK/)
    expect(() => loadConfig({ ...base, CLICKMONK_DNS_CHECK_INTERVAL_MS: '999' })).toThrow(
      /CLICKMONK_DNS_CHECK_INTERVAL_MS/,
    )
  })
})
