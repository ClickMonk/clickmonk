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
})
