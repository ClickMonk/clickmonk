import { createHash } from 'node:crypto'
import { type Words, parseIp } from './ip.js'
import {
  type Range32,
  type Range128,
  RangeTable,
  type TableKind,
  type TableLimits,
  packCountry,
} from './table.js'

export type SourceId = 'country' | 'asn' | 'datacenter' | 'tor'
export const SOURCE_IDS: readonly SourceId[] = ['country', 'asn', 'datacenter', 'tor']

/** The least a download must hold to replace the table in use. */
export interface Minimum {
  k32: number
  k128: number
  /** IPv4 addresses the table must cover in total; country only. */
  v4Addresses?: number
}

export interface Candidate {
  url: string
  /** A dated source names its version; otherwise it is the content's hash. */
  version: string | null
}

export interface SourceDef {
  id: SourceId
  kind: TableKind
  /** Shown by `clickmonk ipdata status` and recorded as the click's geo source. */
  name: string
  licence: string
  attribution: string
  refreshMs: number
  gzip: boolean
  maxDownloadBytes: number
  maxTextBytes: number
  limits: TableLimits
  minimum: Minimum
  /** Downloads to try, in order. */
  candidates(now: Date): Candidate[]
  parse(text: string, limits: TableLimits): RangeTable
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceError'
  }
}

const HOUR = 3_600_000
const MB = 1024 * 1024

type Parsed4or6 = { v: 4; start: number; end: number } | { v: 6; start: Words; end: Words }

function parseRange(startText: string, endText: string, line: number): Parsed4or6 {
  const a = parseIp(startText)
  const b = parseIp(endText)
  if (!a || !b || a.v !== b.v) throw new SourceError(`line ${line}: not an address range`)
  return a.v === 4 && b.v === 4
    ? { v: 4, start: a.n, end: b.n }
    : { v: 6, start: (a as { w: Words }).w, end: (b as { w: Words }).w }
}

function guardCount(r32: unknown[], r128: unknown[], limits: TableLimits, what: string): void {
  if (r32.length > limits.max32 || r128.length > limits.max128) {
    throw new SourceError(
      `${what}: more entries than the bound of ${limits.max32} + ${limits.max128}`,
    )
  }
}

/**
 * DB-IP Lite CSV, one range per line: `start,end,value[,more]`. Fields after
 * the third (the ASN edition's quoted organisation name) are ignored.
 * `toValue` returns null for a line to skip, such as the country `ZZ`
 * DB-IP uses for reserved and unassigned ranges.
 */
function parseDbIpCsv(
  kind: TableKind,
  text: string,
  limits: TableLimits,
  toValue: (field: string, line: number) => number | null,
): RangeTable {
  const r32: Range32[] = []
  const r128: Range128[] = []
  let line = 0
  for (const raw of text.split('\n')) {
    line++
    if (raw.length === 0) continue
    const c1 = raw.indexOf(',')
    const c2 = raw.indexOf(',', c1 + 1)
    if (c1 < 0 || c2 < 0) throw new SourceError(`line ${line}: expected start,end,value`)
    const c3 = raw.indexOf(',', c2 + 1)
    const value = toValue(raw.slice(c2 + 1, c3 < 0 ? undefined : c3).trim(), line)
    if (value === null) continue
    const r = parseRange(raw.slice(0, c1), raw.slice(c1 + 1, c2), line)
    if (r.v === 4) r32.push({ start: r.start, end: r.end, value })
    else r128.push({ start: r.start, end: r.end, value })
    guardCount(r32, r128, limits, kind)
  }
  return RangeTable.build(kind, r32, r128, limits)
}

export function parseDbIpCountry(text: string, limits: TableLimits): RangeTable {
  return parseDbIpCsv('country', text, limits, (field, line) => {
    if (field === 'ZZ') return null
    if (!/^[A-Z]{2}$/.test(field)) throw new SourceError(`line ${line}: not a country code`)
    return packCountry(field)
  })
}

export function parseDbIpAsn(text: string, limits: TableLimits): RangeTable {
  return parseDbIpCsv('asn', text, limits, (field, line) => {
    if (!/^\d{1,10}$/.test(field)) throw new SourceError(`line ${line}: not an ASN`)
    const asn = Number(field)
    if (asn > 0xffffffff) throw new SourceError(`line ${line}: not an ASN`)
    return asn === 0 ? null : asn
  })
}

/** Distinct 32-bit keys as single-key ranges, for a set table. */
function keySet(
  kind: TableKind,
  keys32: Set<number>,
  keys128: Map<string, Words>,
  limits: TableLimits,
): RangeTable {
  const r32 = [...keys32].map((k) => ({ start: k, end: k, value: 1 }))
  const r128 = [...keys128.values()].map((w) => ({ start: w, end: w, value: 1 }))
  guardCount(r32, r128, limits, kind)
  return RangeTable.build(kind, r32, r128, limits)
}

/** `bad-asn-list.csv`: a header line, then `ASN,Entity` per line. The entity is ignored. */
export function parseBadAsnList(text: string, limits: TableLimits): RangeTable {
  const asns = new Set<number>()
  let line = 0
  for (const raw of text.split('\n')) {
    line++
    const trimmed = raw.trim()
    if (trimmed.length === 0 || line === 1) continue
    const field = trimmed
      .slice(0, trimmed.indexOf(',') < 0 ? undefined : trimmed.indexOf(','))
      .replace(/"/g, '')
    if (!/^\d{1,10}$/.test(field) || Number(field) > 0xffffffff || Number(field) === 0) {
      throw new SourceError(`line ${line}: not an ASN`)
    }
    asns.add(Number(field))
    if (asns.size > limits.max32)
      throw new SourceError(`datacenter: more entries than the bound of ${limits.max32}`)
  }
  return keySet('datacenter', asns, new Map(), limits)
}

/** `203.0.113.5:443` or `[2001:db8::5]:443` to the address alone. */
function stripPort(s: string): string {
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'))
  const colon = s.lastIndexOf(':')
  return s.includes('.') && colon > 0 ? s.slice(0, colon) : s
}

/**
 * Onionoo's details document, fetched for running exit relays with only the
 * address fields. Every exit address and every onion-routing address of an
 * exit relay is an address Tor traffic may leave from.
 */
export function parseOnionoo(text: string, limits: TableLimits): RangeTable {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new SourceError('not JSON')
  }
  const relays = (doc as { relays?: unknown }).relays
  if (!Array.isArray(relays)) throw new SourceError('no relays array')
  const v4 = new Set<number>()
  const v6 = new Map<string, Words>()
  for (const relay of relays) {
    const r = relay as { exit_addresses?: unknown; or_addresses?: unknown }
    const addresses = [
      ...(Array.isArray(r.exit_addresses) ? r.exit_addresses : []),
      ...(Array.isArray(r.or_addresses) ? r.or_addresses.map((a) => stripPort(String(a))) : []),
    ]
    for (const a of addresses) {
      const ip = parseIp(String(a))
      if (!ip) throw new SourceError(`not an address: ${String(a).slice(0, 60)}`)
      if (ip.v === 4) v4.add(ip.n)
      else v6.set(ip.w.join(':'), ip.w)
    }
    if (v4.size > limits.max32 || v6.size > limits.max128) {
      throw new SourceError(
        `tor: more entries than the bound of ${limits.max32} + ${limits.max128}`,
      )
    }
  }
  return keySet('tor', v4, v6, limits)
}

/** Throws unless the table holds at least the source's minimum, about a fifth of a real download. */
export function checkMinimum(id: SourceId, table: RangeTable, minimum: Minimum): void {
  const { k32, k128 } = table.size
  if (k32 < minimum.k32 || k128 < minimum.k128) {
    throw new SourceError(
      `${id}: ${k32} + ${k128} entries, fewer than the ${minimum.k32} + ${minimum.k128} a real download holds`,
    )
  }
  if (minimum.v4Addresses !== undefined && table.v4AddressCount() < minimum.v4Addresses) {
    throw new SourceError(
      `${id}: covers ${table.v4AddressCount()} IPv4 addresses, fewer than ${minimum.v4Addresses}`,
    )
  }
}

export function contentVersion(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

function month(now: Date, back: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const DBIP_ATTRIBUTION =
  'IP Geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Converted to ClickMonk’s lookup format.'

/**
 * Every source the updater knows. Adding one is adding an entry here: its
 * licence must be stated and compatible, and its attribution shown.
 * Sizes are set from what each source held when this was written: the
 * limits at a few times that, the minimums at a fifth of it.
 */
export const SOURCES: Record<SourceId, SourceDef> = {
  country: {
    id: 'country',
    kind: 'country',
    name: 'dbip-country-lite',
    licence: 'CC BY 4.0',
    attribution: DBIP_ATTRIBUTION,
    refreshMs: 24 * HOUR,
    gzip: true,
    maxDownloadBytes: 64 * MB,
    maxTextBytes: 128 * MB,
    limits: { max32: 1_000_000, max128: 1_000_000 },
    // Half the IPv4 space: a real edition covers nearly all of it.
    minimum: { k32: 50_000, k128: 20_000, v4Addresses: 2 ** 31 },
    candidates: (now) =>
      [0, 1].map((back) => ({
        url: `https://download.db-ip.com/free/dbip-country-lite-${month(now, back)}.csv.gz`,
        version: month(now, back),
      })),
    parse: parseDbIpCountry,
  },
  asn: {
    id: 'asn',
    kind: 'asn',
    name: 'dbip-asn-lite',
    licence: 'CC BY 4.0',
    attribution: DBIP_ATTRIBUTION,
    refreshMs: 24 * HOUR,
    gzip: true,
    maxDownloadBytes: 64 * MB,
    maxTextBytes: 128 * MB,
    limits: { max32: 1_000_000, max128: 1_000_000 },
    minimum: { k32: 50_000, k128: 10_000 },
    candidates: (now) =>
      [0, 1].map((back) => ({
        url: `https://download.db-ip.com/free/dbip-asn-lite-${month(now, back)}.csv.gz`,
        version: month(now, back),
      })),
    parse: parseDbIpAsn,
  },
  datacenter: {
    id: 'datacenter',
    kind: 'datacenter',
    name: 'bad-asn-list',
    licence: 'MIT',
    attribution:
      'Hosting and datacenter ASNs from bad-asn-list (https://github.com/brianhama/bad-asn-list), Copyright (c) 2025 Brian Hamachek, MIT License.',
    refreshMs: 7 * 24 * HOUR,
    gzip: false,
    maxDownloadBytes: 4 * MB,
    maxTextBytes: 4 * MB,
    limits: { max32: 50_000, max128: 0 },
    minimum: { k32: 100, k128: 0 },
    candidates: () => [
      {
        url: 'https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv',
        version: null,
      },
    ],
    parse: parseBadAsnList,
  },
  tor: {
    id: 'tor',
    kind: 'tor',
    name: 'tor-onionoo',
    licence: 'CC0 1.0',
    attribution:
      'Tor exit relays from the Tor Project’s Onionoo service (https://metrics.torproject.org/onionoo.html), CC0 1.0.',
    refreshMs: 6 * HOUR,
    gzip: false,
    maxDownloadBytes: 16 * MB,
    maxTextBytes: 16 * MB,
    limits: { max32: 50_000, max128: 50_000 },
    minimum: { k32: 100, k128: 0 },
    candidates: () => [
      {
        url: 'https://onionoo.torproject.org/details?flag=Exit&running=true&fields=or_addresses,exit_addresses',
        version: null,
      },
    ],
    parse: parseOnionoo,
  },
}
