import { describe, expect, it } from 'vitest'
import {
  ClickRecordSchema,
  type ClickRecordV1,
  ClickRecordV1Schema,
  type ClickRecordV2,
  ClickRecordV2Schema,
  MAX_RECORD_VERSION,
  SEALED_SEGMENT_RE,
  SpoolRecordSchema,
  ZERO_UUID,
  segmentName,
} from './click-record.js'

const sampleRecord = (over: Partial<ClickRecordV1> = {}): ClickRecordV1 => ({
  v: 1,
  clickId: '01920000-0000-7000-8000-000000000001',
  time: new Date().toISOString(),
  host: 'go.example.test',
  path: '/spring',
  domainId: ZERO_UUID,
  linkId: ZERO_UUID,
  outcome: 'target',
  step: 'destination',
  status: 302,
  destination: 'https://example.com/',
  targetId: null,
  visitorId: 'v1',
  returning: false,
  device: 'desktop',
  country: null,
  userAgent: 'test',
  referrer: '',
  ip: '192.0.2.1',
  capUnchecked: false,
  ...over,
})

describe('ClickRecordV1Schema', () => {
  it('accepts a record', () => {
    expect(ClickRecordV1Schema.safeParse(sampleRecord()).success).toBe(true)
  })

  it.each([
    ['an unknown outcome', { outcome: 'teleported' }],
    ['an over-long user-agent', { userAgent: 'x'.repeat(513) }],
    ['a non-ISO time', { time: 'yesterday' }],
    ['another version', { v: 2 }],
  ])('rejects %s', (_label, over) => {
    expect(ClickRecordV1Schema.safeParse({ ...sampleRecord(), ...over }).success).toBe(false)
  })
})

const sampleV2 = (over: Partial<ClickRecordV2> = {}): ClickRecordV2 => ({
  v: 2,
  clickId: '01920000-0000-7000-8000-000000000002',
  time: new Date().toISOString(),
  host: 'go.example.test',
  path: '/spring',
  domainId: ZERO_UUID,
  linkId: ZERO_UUID,
  outcome: 'blocked',
  step: 'classify',
  status: 403,
  destination: null,
  targetId: null,
  visitorId: 'v1',
  returning: false,
  device: 'desktop',
  country: 'DE',
  userAgent: 'curl/8.5.0',
  referrer: '',
  ip: '192.0.2.1',
  capUnchecked: false,
  trafficClass: 'bot',
  signals: ['ua_bot', 'rate'],
  action: 'block',
  os: 'other',
  browser: 'other',
  asn: 64500,
  geoSource: 'dbip-country-lite/2026-01',
  ...over,
})

describe('ClickRecordV2Schema', () => {
  it('accepts a classified record, and one with nothing looked up', () => {
    expect(ClickRecordV2Schema.safeParse(sampleV2()).success).toBe(true)
    expect(
      ClickRecordV2Schema.safeParse(
        sampleV2({
          trafficClass: 'unknown',
          signals: [],
          action: null,
          asn: null,
          geoSource: '',
          country: null,
        }),
      ).success,
    ).toBe(true)
  })

  it('takes the largest ASN a UInt32 column holds, and nothing past it', () => {
    expect(ClickRecordV2Schema.safeParse(sampleV2({ asn: 4294967295 })).success).toBe(true)
    expect(ClickRecordV2Schema.safeParse(sampleV2({ asn: 4294967296 })).success).toBe(false)
  })

  it.each([
    ['an unknown class', { trafficClass: 'robot' }],
    ['an unknown action', { action: 'drop' }],
    ['a negative ASN', { asn: -1 }],
    ['a fractional ASN', { asn: 1.5 }],
    ['a signal that is not a short lower-case name', { signals: ['UA_BOT'] }],
    ['more than 16 signals', { signals: Array.from({ length: 17 }, () => 'ua_bot') }],
    ['an empty OS', { os: '' }],
    ['a browser name past 24 characters', { browser: 'b'.repeat(25) }],
    ['a geo source past 128 characters', { geoSource: 'g'.repeat(129) }],
  ])('rejects %s', (_label, over) => {
    expect(ClickRecordV2Schema.safeParse({ ...sampleV2(), ...over }).success).toBe(false)
  })
})

/**
 * Why a line was refused, not merely that it was: a fixture broken in some
 * other way would make a refusal test pass without exercising the rule it
 * names.
 */
const refusedFor = (value: unknown): string[] => {
  const r = SpoolRecordSchema.safeParse(value)
  expect(r.success).toBe(false)
  return r.success ? [] : r.error.issues.map((i) => `${i.code}:${i.path.join('.')}`)
}

describe('SpoolRecordSchema', () => {
  it('reads version 1 and version 2, each by its own rules', () => {
    expect(SpoolRecordSchema.safeParse(sampleRecord()).success).toBe(true)
    expect(SpoolRecordSchema.safeParse(sampleV2()).success).toBe(true)
    // A v1 line with v2 fields, and a v2 line without them, are both malformed.
    expect(SpoolRecordSchema.safeParse({ ...sampleRecord(), trafficClass: 'bot' }).success).toBe(
      false,
    )
    const { trafficClass, ...noClass } = sampleV2()
    expect(SpoolRecordSchema.safeParse(noClass).success).toBe(false)
    expect(ClickRecordV1Schema.safeParse(sampleV2()).success).toBe(false)
  })

  it('reads no other version, and refuses it on the version rather than its fields', () => {
    expect(refusedFor({ ...sampleV2(), v: 4 })).toEqual(['invalid_union_discriminator:v'])
  })
})

describe('version 3: the password step', () => {
  const sampleV3 = (over: Record<string, unknown> = {}) => ({ ...sampleV2(), v: 3, ...over })

  it('is the version the redirect writes, and the newest the worker reads', () => {
    expect(MAX_RECORD_VERSION).toBe(3)
    expect(ClickRecordSchema.safeParse(sampleV3()).success).toBe(true)
    expect(SpoolRecordSchema.safeParse(sampleV3()).success).toBe(true)
  })

  it('takes the password outcome and step', () => {
    expect(
      SpoolRecordSchema.safeParse(sampleV3({ outcome: 'password', step: 'password', status: 200 }))
        .success,
    ).toBe(true)
  })

  // The version is what tells an older worker to leave the segment alone. If
  // version 2 took the new outcome, a worker that does not know it would read
  // the line as malformed and drop the click instead.
  it('is what carries them: version 2 does not', () => {
    expect(refusedFor({ ...sampleV2(), outcome: 'password' })).toEqual([
      'invalid_enum_value:outcome',
    ])
    expect(refusedFor({ ...sampleV2(), step: 'password' })).toEqual(['invalid_enum_value:step'])
  })

  it('still refuses everything version 2 refuses', () => {
    expect(refusedFor(sampleV3({ outcome: 'teleported' }))).toEqual(['invalid_enum_value:outcome'])
    expect(refusedFor(sampleV3({ trafficClass: 'robot' }))).toEqual([
      'invalid_enum_value:trafficClass',
    ])
    expect(refusedFor(sampleV3({ extra: 1 }))).toEqual(['unrecognized_keys:'])
  })
})

/**
 * The click time against the range the rollups' `hour` column holds, on every
 * version, because `common` is where the field is written once.
 *
 * The instants are written out rather than computed from the constants: a bound
 * derived from the value it is testing holds whatever that value becomes. A time
 * outside this range is not refused by the store — the materialized views wrap it
 * into an hour decades away, which is missing from every rollup-backed report and
 * permanently wrong in the freshness field the reports answer with.
 */
describe('the click time against what a rollup hour holds', () => {
  it('takes the instants that column holds, and nothing outside them', () => {
    for (const time of ['1970-01-01T00:00:00.000Z', '2106-02-07T06:28:15.000Z']) {
      expect(SpoolRecordSchema.safeParse(sampleRecord({ time })).success, time).toBe(true)
    }
    for (const time of [
      '1969-12-31T23:59:59.999Z',
      '1950-06-15T10:00:00.000Z',
      '2106-02-07T06:28:16.000Z',
      '2150-06-15T10:00:00.000Z',
    ]) {
      expect(SpoolRecordSchema.safeParse(sampleRecord({ time })).success, time).toBe(false)
    }
  })

  // Refused on the time and not on something else the fixture happens to break,
  // and on all three versions: the field is written once in `common`, so a bound
  // added to one version only would leave the other two open.
  it('refuses it on every record version, and refuses it for the time', () => {
    const time = '1950-06-15T10:00:00.000Z'
    expect(refusedFor(sampleRecord({ time }))).toEqual(['custom:time'])
    expect(refusedFor(sampleV2({ time }))).toEqual(['custom:time'])
    expect(refusedFor({ ...sampleV2(), v: 3, time })).toEqual(['custom:time'])
  })
})

describe('spool segment names', () => {
  it('are what the reader matches, and sort by time as strings', () => {
    const name = segmentName(1_700_000_000_000, 42, 0)
    expect(name).toBe('seg-001700000000000-42-0.ndjson')
    expect(SEALED_SEGMENT_RE.test(name)).toBe(true)
    expect(SEALED_SEGMENT_RE.test('open-42-0.part')).toBe(false)
    expect(segmentName(999, 99, 99) < name).toBe(true)
  })
})
