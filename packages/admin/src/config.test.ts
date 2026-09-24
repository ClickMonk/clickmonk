import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  CLICKMONK_POSTGRES_URL: 'postgres://u:p@db:5432/clickmonk',
  CLICKMONK_CLICKHOUSE_URL: 'http://clickhouse:8123',
  CLICKMONK_CLICKHOUSE_USER: 'clickmonk',
  CLICKMONK_CLICKHOUSE_PASSWORD: 'a clickhouse password',
  CLICKMONK_CLICKHOUSE_DB: 'clickmonk',
}

describe('loadConfig', () => {
  // The whole object, not a subset: a field this service starts with and
  // nobody pinned is a field a later change can quietly drop.
  it('applies the documented defaults', () => {
    expect(loadConfig(base)).toEqual({
      postgresUrl: 'postgres://u:p@db:5432/clickmonk',
      ch: {
        url: 'http://clickhouse:8123',
        username: 'clickmonk',
        password: 'a clickhouse password',
        database: 'clickmonk',
      },
      adminHost: null,
      port: 9100,
      trustedProxies: ['127.0.0.1'],
      dnsServers: [],
    })
  })

  // All four, one row each: the comment on them claims that an install with a
  // typo fails at boot with the variable named, and three of the four were
  // otherwise free to become optional with that claim still written down.
  it.each([
    'CLICKMONK_CLICKHOUSE_URL',
    'CLICKMONK_CLICKHOUSE_USER',
    'CLICKMONK_CLICKHOUSE_PASSWORD',
    'CLICKMONK_CLICKHOUSE_DB',
  ])('refuses to start without %s, which the reports read', (name) => {
    const rest: Record<string, string> = { ...base }
    delete rest[name]
    expect(() => loadConfig(rest)).toThrow(new RegExp(name))
  })

  // The password is the one that needs saying: empty is a value an operator may
  // have set, and it is not the same as the variable being absent above.
  it('takes an empty ClickHouse password, which is not the same as none', () => {
    expect(loadConfig({ ...base, CLICKMONK_CLICKHOUSE_PASSWORD: '' }).ch.password).toBe('')
  })

  it('names every missing or bad variable at once', () => {
    expect(() => loadConfig({ CLICKMONK_ADMIN_PORT: 'http' })).toThrow(
      /CLICKMONK_POSTGRES_URL[\s\S]*CLICKMONK_ADMIN_PORT/,
    )
  })

  it('takes a port, and refuses one outside the range', () => {
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_PORT: '9999' }).port).toBe(9999)
    for (const value of ['0', '65536', '9100.5', 'nine']) {
      expect(() => loadConfig({ ...base, CLICKMONK_ADMIN_PORT: value }), value).toThrow(
        /CLICKMONK_ADMIN_PORT/,
      )
    }
  })

  it('splits trusted proxies, and refuses an entry that is not one', () => {
    expect(
      loadConfig({ ...base, CLICKMONK_TRUSTED_PROXIES: 'uniquelocal, 198.51.100.0/24' })
        .trustedProxies,
    ).toEqual(['uniquelocal', '198.51.100.0/24'])
    expect(() => loadConfig({ ...base, CLICKMONK_TRUSTED_PROXIES: '0.0.0.0/0' })).toThrow(
      /invalid configuration:\n {2}CLICKMONK_TRUSTED_PROXIES: /,
    )
  })

  it('splits resolver addresses, and refuses one that is a host name', () => {
    expect(
      loadConfig({ ...base, CLICKMONK_DNS_SERVERS: '192.0.2.53, [2001:db8::53]:5353' }).dnsServers,
    ).toEqual(['192.0.2.53', '[2001:db8::53]:5353'])
    expect(() => loadConfig({ ...base, CLICKMONK_DNS_SERVERS: 'resolver.example.test' })).toThrow(
      /invalid configuration:\n {2}CLICKMONK_DNS_SERVERS: /,
    )
  })
})

// This service and the redirect read this variable through one schema, held in
// core: the redirect approves a certificate for exactly this name and this
// service refuses every other Host, so they cannot be allowed to disagree about
// what the name is. What is checked here is that this service's loader actually
// applies that schema and maps its result — the rows are the redirect's rows,
// so a change to the shared schema fails both files together.
describe('the admin host', () => {
  it('is null when it is not set, so every route answers 503 until it is', () => {
    expect(loadConfig(base).adminHost).toBeNull()
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_HOST: '' }).adminHost).toBeNull()
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_HOST: '   ' }).adminHost).toBeNull()
    expect(loadConfig({ ...base, CLICKMONK_ADMIN_HOST: ' admin.example.test ' }).adminHost).toBe(
      'admin.example.test',
    )
  })

  // A value with a scheme or a port would match no Host header and no `ask`
  // query, so the install would look configured and quietly have no admin
  // interface. It fails the configuration instead, naming the variable.
  // The two wildcards are the ones worth stating: the reverse proxy's own host
  // matcher would honour `*.example.test`, so an operator who wrote one here
  // would be routing every link domain under it to the admin API. Both
  // services parse this variable with this schema and refuse to boot instead,
  // which is a crash-loop an operator sees rather than a mis-route nobody sees.
  it.each([
    'https://admin.example.test',
    'admin.example.test:443',
    'Admin.Example.Test',
    'not a host',
    '*',
    '*.example.test',
  ])('refuses %s', (value) => {
    expect(() => loadConfig({ ...base, CLICKMONK_ADMIN_HOST: value })).toThrow(
      /CLICKMONK_ADMIN_HOST/,
    )
  })
})
