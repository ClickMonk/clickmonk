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
})
