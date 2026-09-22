import { describe, expect, it } from 'vitest'
import {
  type ClickRecordV1,
  ClickRecordV1Schema,
  type ClickRecordV2,
  ClickRecordV2Schema,
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
    ['another version', { v: 3 }],
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

  it('reads no other version', () => {
    expect(SpoolRecordSchema.safeParse({ ...sampleV2(), v: 3 }).success).toBe(false)
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
