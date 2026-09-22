import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('reads the stores and defaults the spool directory', () => {
    expect(
      loadConfig({
        CLICKMONK_POSTGRES_URL: 'postgres://u:p@db:5432/clickmonk',
        CLICKMONK_CLICKHOUSE_URL: 'http://clickhouse:8123',
        CLICKMONK_CLICKHOUSE_USER: 'clickmonk',
        CLICKMONK_CLICKHOUSE_PASSWORD: 'secret',
        CLICKMONK_CLICKHOUSE_DB: 'clickmonk',
      }),
    ).toMatchObject({ spoolDir: '/var/lib/clickmonk/spool', ch: { database: 'clickmonk' } })
  })

  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/CLICKMONK_POSTGRES_URL[\s\S]*CLICKMONK_CLICKHOUSE_URL/)
  })
})
