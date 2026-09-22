import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SOURCES,
  parseBadAsnList,
  parseDbIpAsn,
  parseDbIpCountry,
  parseOnionoo,
} from './sources.js'
import {
  IpDataStore,
  MANIFEST_FILE,
  MAX_MANIFEST_BYTES,
  commitTables,
  readManifest,
} from './store.js'
import type { RangeTable } from './table.js'

// Made-up data on the documentation ranges and the documentation ASNs.
const country = (code = 'DE') =>
  parseDbIpCountry(
    `192.0.2.0,192.0.2.255,${code}\n198.51.100.0,198.51.100.255,FR\n2001:db8::,2001:db8::ffff,NL\n`,
    SOURCES.country.limits,
  )
const asn = () =>
  parseDbIpAsn(
    '192.0.2.0,192.0.2.255,64500,"Example Home, Inc."\n198.51.100.0,198.51.100.255,64501,"Example Hosting"\n',
    SOURCES.asn.limits,
  )
const datacenter = () =>
  parseBadAsnList('ASN,Entity\n64501,Example Hosting\n', SOURCES.datacenter.limits)
const tor = () =>
  parseOnionoo(
    JSON.stringify({ relays: [{ exit_addresses: ['198.51.100.9'] }] }),
    SOURCES.tor.limits,
  )

const at = (table: RangeTable, version = 'v1') => ({ table, version, fetchedAt: new Date() })
const all = () => ({
  country: at(country(), '2026-01'),
  asn: at(asn()),
  datacenter: at(datacenter()),
  tor: at(tor()),
})
const tmp = () => mkdtempSync(join(tmpdir(), 'clickmonk-ipdata-'))
const store = (dir: string, log: (m: string) => void = () => {}) => new IpDataStore({ dir, log })

describe('IpDataStore', () => {
  it('answers every fact from the tables the manifest names', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const s = store(dir)
    expect(await s.refresh()).toBe(true)
    expect(s.current()?.lookup('192.0.2.7')).toEqual({
      country: 'DE',
      asn: 64500,
      tor: false,
      datacenter: false,
      geoSource: 'dbip-country-lite/2026-01',
    })
    expect(s.current()?.lookup('198.51.100.9')).toMatchObject({
      country: 'FR',
      asn: 64501,
      tor: true,
      datacenter: true,
    })
    expect(s.current()?.lookup('2001:db8::1')).toMatchObject({ country: 'NL', asn: null })
    expect(s.current()?.lookup('::ffff:192.0.2.7')?.country).toBe('DE')
  })

  it('has no data, and says so, while there is no manifest', async () => {
    const lines: string[] = []
    const s = store(tmp(), (m) => lines.push(m))
    await s.start()
    s.stop()
    expect(s.current()).toBeNull()
    expect(lines.join('\n')).toMatch(/no IP data yet/)
  })

  it('leaves a fact unchecked (null) when its table is not loaded', async () => {
    const dir = tmp()
    commitTables(dir, { country: at(country()) })
    const s = store(dir)
    await s.refresh()
    expect(s.current()?.lookup('198.51.100.9')).toEqual({
      country: 'FR',
      asn: null,
      tor: null,
      datacenter: null,
      geoSource: 'dbip-country-lite/v1',
    })
  })

  it('cannot call an address datacenter without the ASN table', async () => {
    const dir = tmp()
    commitTables(dir, { datacenter: at(datacenter()) })
    const s = store(dir)
    await s.refresh()
    expect(s.current()?.lookup('198.51.100.9').datacenter).toBeNull()
  })

  it('checks nothing for a string that is not an address', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const s = store(dir)
    await s.refresh()
    expect(s.current()?.lookup('')).toEqual({
      country: null,
      asn: null,
      tor: null,
      datacenter: null,
      geoSource: '',
    })
  })

  it('reloads when the manifest changes, and not otherwise', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const s = store(dir)
    await s.refresh()
    const first = s.current()
    expect(await s.refresh()).toBe(false)
    expect(s.current()).toBe(first)
    commitTables(dir, { country: at(country('AT'), '2026-02') })
    expect(await s.refresh()).toBe(true)
    expect(s.current()?.lookup('192.0.2.7')).toMatchObject({
      country: 'AT',
      asn: 64500,
      geoSource: 'dbip-country-lite/2026-02',
    })
  })

  it('keeps the table in use when the new file for it cannot be loaded, and applies the rest', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const lines: string[] = []
    const s = store(dir, (m) => lines.push(m))
    await s.refresh()
    const m = commitTables(dir, {
      country: at(country('AT'), '2026-02'),
      tor: at(parseOnionoo('{"relays":[]}', SOURCES.tor.limits)),
    })
    writeFileSync(join(dir, m.sources.country?.file as string), 'not a table')
    expect(await s.refresh()).toBe(true)
    expect(s.current()?.lookup('192.0.2.7').country).toBe('DE')
    expect(s.current()?.lookup('198.51.100.9').tor).toBe(false)
    expect(lines.join('\n')).toMatch(/could not load IP data country/)
  })

  it('refuses a table file over its bound without reading it', async () => {
    const dir = tmp()
    const m = commitTables(dir, all())
    // Sparse: past the bound on paper, with no disk used.
    truncateSync(join(dir, m.sources.tor?.file as string), 64 * 1024 * 1024)
    const errors: unknown[] = []
    const s = new IpDataStore({ dir, log: (_msg, err) => errors.push(err) })
    await s.refresh()
    expect(s.current()?.lookup('198.51.100.9')).toMatchObject({ country: 'FR', tor: null })
    // The size check's own message, not the decoder's: the file was never read.
    expect(String(errors[0])).toMatch(/over the bound of \d+ bytes/)
  })

  it('refuses a manifest naming a file outside its directory, and keeps everything loaded', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const lines: string[] = []
    const s = store(dir, (m) => lines.push(m))
    await s.refresh()
    const entry = {
      version: 'x',
      fetchedAt: new Date().toISOString(),
      entries: { k32: 0, k128: 0 },
    }
    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({
        v: 1,
        sources: { country: { ...entry, file: '../country-0000000000000000.cmrt' } },
      }),
    )
    expect(await s.refresh()).toBe(false)
    expect(s.current()?.lookup('192.0.2.7').country).toBe('DE')
    // Refused as a manifest, before any file it names is opened.
    expect(lines).toEqual(['could not read the IP data manifest; keeping what is loaded'])
  })

  it('refuses a manifest over its bound without reading it, and keeps everything loaded', async () => {
    const dir = tmp()
    commitTables(dir, all())
    const errors: unknown[] = []
    const s = new IpDataStore({ dir, log: (_msg, err) => errors.push(err) })
    await s.refresh()
    // Sparse: past the bound on paper, with no disk used.
    truncateSync(join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES + 1)
    expect(await s.refresh()).toBe(false)
    expect(s.current()?.lookup('192.0.2.7').country).toBe('DE')
    // The size check's own message, not JSON.parse's: the file was never read.
    expect(String(errors[0])).toMatch(/over the bound of 65536 bytes/)
  })

  it('shares one load between overlapping refreshes', () => {
    const s = store(tmp())
    expect(s.refresh()).toBe(s.refresh())
  })

  it('tries a table that failed to load again on the next refresh', async () => {
    const dir = tmp()
    const m = commitTables(dir, all())
    const file = join(dir, m.sources.tor?.file as string)
    const good = readFileSync(file)
    writeFileSync(file, 'not yet')
    const s = store(dir)
    await s.refresh()
    expect(s.current()?.lookup('198.51.100.9').tor).toBeNull()
    writeFileSync(file, good)
    expect(await s.refresh()).toBe(true)
    expect(s.current()?.lookup('198.51.100.9').tor).toBe(true)
  })
})

describe('commitTables', () => {
  it('keeps the files of this manifest and the one it replaced, and removes the rest', () => {
    const dir = tmp()
    const first = commitTables(dir, { country: at(country('AT')) })
    const second = commitTables(dir, { country: at(country('BE')) })
    const third = commitTables(dir, { country: at(country('CH')) })
    const files = readdirSync(dir)
    expect(files).not.toContain(first.sources.country?.file)
    expect(files).toContain(second.sources.country?.file)
    expect(files).toContain(third.sources.country?.file)
    expect(readManifest(dir)).toEqual(third)
  })

  it('keeps the other sources when one is updated', () => {
    const dir = tmp()
    commitTables(dir, all())
    const next = commitTables(dir, { tor: at(tor(), 'v2') })
    expect(Object.keys(next.sources).sort()).toEqual(['asn', 'country', 'datacenter', 'tor'])
    expect(next.sources.tor?.version).toBe('v2')
    for (const e of Object.values(next.sources)) expect(existsSync(join(dir, e.file))).toBe(true)
  })

  it('leaves no temporary file behind', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'manifest.json.tmp'), 'left by a crash')
    commitTables(dir, all())
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
