import type { Settings } from '@/api/types'
import { describe, expect, it } from 'vitest'
import { deletion, settingsFormOf, settingsInputOf, settingsProblems } from './settingsForm'

const S: Settings = {
  traffic: {
    actions: { bot: 'flag', abuser: 'block', anonymous: 'flag', datacenter: 'nothing' },
    safeUrl: null,
    abuserThreshold: 60,
  },
  retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
  note: null,
  problem: null,
}

describe('the settings form', () => {
  it('reads the settings into the form, and writes them back whole', () => {
    const f = settingsFormOf(S)
    expect(f).toEqual({
      actions: { bot: 'flag', abuser: 'block', anonymous: 'flag', datacenter: 'nothing' },
      safeUrl: '',
      abuserThreshold: '60',
      raw: { forever: false, days: '90' },
      ip: { forever: false, days: '30' },
    })
    expect(settingsInputOf(f)).toEqual({
      traffic: S.traffic,
      retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
    })
  })

  it('writes for ever as null', () => {
    const f = { ...settingsFormOf(S), raw: { forever: true, days: '' } }
    expect(settingsInputOf(f).retention).toEqual({ rawRetentionDays: null, ipRetentionDays: 30 })
  })

  it('leaves retention empty when the service could not read it', () => {
    const f = settingsFormOf({ ...S, retention: null, problem: 'the stored row could not be read' })
    expect([f.raw, f.ip]).toEqual([
      { forever: false, days: '' },
      { forever: false, days: '' },
    ])
    expect(settingsProblems(f)).toEqual({
      raw: 'Choose a number of days, or for ever.',
      ip: 'Choose a number of days, or for ever.',
    })
  })

  it.each([
    [
      'a threshold of zero',
      { abuserThreshold: '0' },
      { abuserThreshold: 'A whole number from 1 to 100,000.' },
    ],
    [
      'a threshold past the ceiling',
      { abuserThreshold: '100001' },
      { abuserThreshold: 'A whole number from 1 to 100,000.' },
    ],
    [
      'a period of zero days',
      { raw: { forever: false, days: '0' } },
      { raw: 'A whole number of days from 1 to 3,650.' },
    ],
    [
      'a period past ten years',
      { ip: { forever: false, days: '3651' } },
      { ip: 'A whole number of days from 1 to 3,650.' },
    ],
    [
      'the safe action with no safe URL',
      { actions: { ...S.traffic.actions, bot: 'safe' as const } },
      { safeUrl: 'The safe action needs a safe URL.' },
    ],
  ])('refuses %s', (_label, change, problems) => {
    expect(settingsProblems({ ...settingsFormOf(S), ...change })).toEqual(problems)
  })
})

describe('whether a save deletes data, and the button that confirms it', () => {
  const now = { rawRetentionDays: 90, ipRetentionDays: 30 }
  const forever = { rawRetentionDays: null, ipRetentionDays: null }
  const both =
    'Clicks older than 90 days will be deleted within the hour, when the worker next runs. Addresses older than 30 days will be blanked within the hour, when the worker next runs. This cannot be undone.'

  it('says a shorter click period deletes clicks, and names the button after it', () => {
    expect(deletion(now, { rawRetentionDays: 30, ipRetentionDays: 30 })).toEqual({
      sentence:
        'Clicks older than 30 days will be deleted within the hour, when the worker next runs. This cannot be undone.',
      action: 'Delete older clicks and save',
    })
  })

  it('says a shorter address period blanks addresses, and names the button after it', () => {
    expect(deletion(now, { rawRetentionDays: 90, ipRetentionDays: 7 })).toEqual({
      sentence:
        'Addresses older than 7 days will be blanked within the hour, when the worker next runs. This cannot be undone.',
      action: 'Blank older addresses and save',
    })
  })

  it('says a period where there was for ever deletes, for both, and names the button after both', () => {
    expect(deletion(forever, now)).toEqual({ sentence: both, action: 'Delete older data and save' })
  })

  it.each([
    ['a longer period', { rawRetentionDays: 180, ipRetentionDays: 30 }],
    ['for ever', forever],
    ['the same periods again', now],
  ])('says %s deletes nothing', (_label, after) => {
    expect(deletion(now, after)).toBeNull()
  })

  it('treats settings it could not read as keeping everything, and asks', () => {
    expect(deletion(null, now)).toEqual({ sentence: both, action: 'Delete older data and save' })
  })
})
