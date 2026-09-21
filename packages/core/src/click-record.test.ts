import { describe, expect, it } from 'vitest'
import {
  type ClickRecord,
  ClickRecordSchema,
  SEALED_SEGMENT_RE,
  ZERO_UUID,
  segmentName,
} from './click-record.js'

const sampleRecord = (over: Partial<ClickRecord> = {}): ClickRecord => ({
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

describe('ClickRecordSchema', () => {
  it('accepts a record', () => {
    expect(ClickRecordSchema.safeParse(sampleRecord()).success).toBe(true)
  })

  it.each([
    ['an unknown outcome', { outcome: 'teleported' }],
    ['an over-long user-agent', { userAgent: 'x'.repeat(513) }],
    ['a non-ISO time', { time: 'yesterday' }],
    ['another version', { v: 2 }],
  ])('rejects %s', (_label, over) => {
    expect(ClickRecordSchema.safeParse({ ...sampleRecord(), ...over }).success).toBe(false)
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
