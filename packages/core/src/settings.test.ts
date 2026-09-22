import { describe, expect, it } from 'vitest'
import { DEFAULT_TRAFFIC_SETTINGS, TrafficSettingsSchema } from './settings.js'

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
