import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETENTION,
  DEFAULT_TRAFFIC_SETTINGS,
  MAX_RETENTION_DAYS,
  RetentionSettingsSchema,
  TrafficSettingsSchema,
  retentionNote,
} from './settings.js'

describe('TrafficSettingsSchema', () => {
  it('accepts the defaults', () => {
    expect(TrafficSettingsSchema.parse(DEFAULT_TRAFFIC_SETTINGS)).toEqual(DEFAULT_TRAFFIC_SETTINGS)
  })

  it('refuses the safe action without a safe URL, and accepts it with one', () => {
    const actions = { ...DEFAULT_TRAFFIC_SETTINGS.actions, datacenter: 'safe' as const }
    const without = TrafficSettingsSchema.safeParse({ ...DEFAULT_TRAFFIC_SETTINGS, actions })
    expect(without.success).toBe(false)
    expect(without.error?.issues[0]?.path).toEqual(['actions', 'datacenter'])
    expect(
      TrafficSettingsSchema.safeParse({
        ...DEFAULT_TRAFFIC_SETTINGS,
        actions,
        safeUrl: 'https://example.com/safe?c={click_id}',
      }).success,
    ).toBe(true)
  })

  it.each([
    ['an unknown action', { actions: { ...DEFAULT_TRAFFIC_SETTINGS.actions, bot: 'drop' } }],
    ['a missing class', { actions: { bot: 'flag', abuser: 'flag', anonymous: 'flag' } }],
    [
      'a class that does not exist',
      { actions: { ...DEFAULT_TRAFFIC_SETTINGS.actions, human: 'flag' } },
    ],
    ['a threshold of zero', { abuserThreshold: 0 }],
    ['a threshold past the bound', { abuserThreshold: 100_001 }],
    ['a safe URL that is not a URL', { safeUrl: 'not a url' }],
  ])('rejects %s', (_label, over) => {
    expect(TrafficSettingsSchema.safeParse({ ...DEFAULT_TRAFFIC_SETTINGS, ...over }).success).toBe(
      false,
    )
  })
})

describe('RetentionSettingsSchema', () => {
  it('accepts the defaults: ninety days of clicks and thirty of addresses', () => {
    expect(DEFAULT_RETENTION).toEqual({ rawRetentionDays: 90, ipRetentionDays: 30 })
    expect(RetentionSettingsSchema.parse(DEFAULT_RETENTION)).toEqual(DEFAULT_RETENTION)
  })

  // The refusal below names 3651, which pins the bound only relative to
  // wherever it happens to be. Both numbers here are written out, so lowering
  // the ceiling — ten years to one, say — fails here rather than passing a
  // suite that never mentions the constant.
  it('bounds either period at ten years, and accepts exactly that', () => {
    expect(MAX_RETENTION_DAYS).toBe(3650)
    expect(
      RetentionSettingsSchema.safeParse({ rawRetentionDays: 3650, ipRetentionDays: 3650 }).success,
    ).toBe(true)
  })

  it('takes null for either period, meaning never', () => {
    const forever = { rawRetentionDays: null, ipRetentionDays: null }
    expect(RetentionSettingsSchema.parse(forever)).toEqual(forever)
  })

  it.each([
    ['zero, which reads as both forever and now', { rawRetentionDays: 0, ipRetentionDays: 30 }],
    ['a negative period', { rawRetentionDays: 90, ipRetentionDays: -1 }],
    ['a fraction of a day', { rawRetentionDays: 1.5, ipRetentionDays: 30 }],
    ['more than ten years', { rawRetentionDays: 3651, ipRetentionDays: 30 }],
    ['a period as a string', { rawRetentionDays: '90', ipRetentionDays: 30 }],
    ['a field nobody knows', { rawRetentionDays: 90, ipRetentionDays: 30, keepEverything: true }],
  ])('refuses %s', (_label, value) => {
    expect(RetentionSettingsSchema.safeParse(value).success).toBe(false)
  })

  // Not a refusal: lowering the raw period below the IP period is a
  // tightening, and a check that refused it would refuse the safe direction.
  it('notes an IP period that outlives the clicks it belongs to, and refuses nothing', () => {
    expect(retentionNote({ rawRetentionDays: 30, ipRetentionDays: 90 })).toBe(
      'addresses are set to be kept for 90 days but clicks for 30 days, so an address goes when its click does, after 30 days',
    )
    expect(
      RetentionSettingsSchema.safeParse({ rawRetentionDays: 30, ipRetentionDays: 90 }).success,
    ).toBe(true)
  })

  it.each([
    ['both set the usual way round', { rawRetentionDays: 90, ipRetentionDays: 30 }],
    ['clicks kept forever', { rawRetentionDays: null, ipRetentionDays: 30 }],
    [
      'addresses kept forever with clicks kept forever',
      { rawRetentionDays: null, ipRetentionDays: null },
    ],
    ['the same period for both', { rawRetentionDays: 30, ipRetentionDays: 30 }],
  ])('has nothing to say about %s', (_label, value) => {
    expect(retentionNote(value)).toBeNull()
  })

  it('notes an address kept forever while the clicks are not', () => {
    expect(retentionNote({ rawRetentionDays: 90, ipRetentionDays: null })).toBe(
      'addresses are set to be kept for ever but clicks for 90 days, so an address goes when its click does, after 90 days',
    )
  })
})
