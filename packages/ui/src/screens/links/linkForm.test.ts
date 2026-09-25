import type { Link } from '@/api/types'
import { describe, expect, it } from 'vitest'
import {
  blankForm,
  fieldErrors,
  formOf,
  inputOf,
  instantToLocal,
  localToInstant,
  patchOf,
  problemsOf,
} from './linkForm'

const ADL = 'Australia/Adelaide'

const LINK: Link = {
  id: 'l1',
  domainId: 'd1',
  host: 'go.example.test',
  slug: 'spring',
  url: 'https://go.example.test/spring',
  name: 'Spring offer',
  enabled: true,
  targets: [{ id: 't1', url: 'https://example.com/offer', weight: 100 }],
  backupUrl: null,
  deviceUrls: { ios: 'https://example.com/ios' },
  returningUrl: null,
  countries: { mode: 'all' },
  clickCap: 1000,
  capUsed: 12,
  expiresAt: '2026-11-11T13:30:00.000Z',
  passthrough: true,
  trafficActions: {},
  hasPassword: true,
  createdAt: '2026-09-01T00:00:00.000Z',
}

describe('the expiry, in the operator’s zone', () => {
  it('turns a local time into the instant it names, and back', () => {
    expect(localToInstant('2026-11-12T00:00', ADL)).toBe('2026-11-11T13:30:00.000Z')
    expect(instantToLocal('2026-11-11T13:30:00.000Z', ADL)).toBe('2026-11-12T00:00')
  })

  it('takes a time the clocks skip as the hour before', () => {
    expect(localToInstant('2026-10-04T02:30', ADL)).toBe('2026-10-03T16:00:00.000Z')
    expect(instantToLocal('2026-10-03T16:00:00.000Z', ADL)).toBe('2026-10-04T01:30')
  })

  // Behind UTC, a local time read as UTC is earlier than the instant it names,
  // so a guess corrected from there lands on the far side of the change: 01:30
  // rather than 23:30. Havana and Santiago skip midnight; Cairo, ahead of UTC,
  // does too.
  it.each([
    ['America/Havana', '2026-03-08T00:30', '2026-03-08T04:30:00.000Z', '2026-03-07T23:30'],
    ['America/Santiago', '2026-09-06T00:30', '2026-09-06T03:30:00.000Z', '2026-09-05T23:30'],
    ['Africa/Cairo', '2026-04-24T00:30', '2026-04-23T21:30:00.000Z', '2026-04-23T23:30'],
  ])('takes a skipped time as the hour before in %s', (zone, local, instant, shown) => {
    expect(localToInstant(local, zone)).toBe(instant)
    expect(instantToLocal(instant, zone)).toBe(shown)
  })

  it('takes the times either side of a skipped hour as themselves', () => {
    expect(localToInstant('2026-03-07T23:59', 'America/Havana')).toBe('2026-03-08T04:59:00.000Z')
    expect(localToInstant('2026-03-08T01:00', 'America/Havana')).toBe('2026-03-08T05:00:00.000Z')
  })

  // 02:30 on the morning Adelaide's clocks go back happens twice, at 16:00 and
  // at 17:00 UTC. The first is the one meant.
  it('takes a time that happens twice as the first of the two', () => {
    expect(localToInstant('2026-04-05T02:30', ADL)).toBe('2026-04-04T16:00:00.000Z')
    expect(localToInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
  })
})

describe('creating a link', () => {
  it('sends what was filled in and nothing else, and leaves the slug to the install when it is empty', () => {
    const s = {
      ...blankForm('go.example.test'),
      targets: [{ url: 'https://example.com/offer', weight: '100' }],
    }
    expect(inputOf(s, ADL)).toEqual({
      host: 'go.example.test',
      targets: [{ url: 'https://example.com/offer' }],
    })
  })

  it('sends every field it was given', () => {
    const s = {
      ...blankForm('go.example.test'),
      slug: 'spring',
      name: 'Spring offer',
      targets: [
        { url: 'https://example.com/a', weight: '70' },
        { url: 'https://example.com/b', weight: '30' },
      ],
      backupUrl: 'https://example.com/backup',
      deviceUrls: { ios: 'https://example.com/ios', android: '', desktop: '' },
      countryMode: 'block' as const,
      countryList: 'us, ca',
      clickCap: '1000',
      expiresAt: '2026-11-12T00:00',
      passthrough: false,
      trafficActions: {
        bot: 'block' as const,
        abuser: 'inherit' as const,
        anonymous: 'inherit' as const,
        datacenter: 'safe' as const,
      },
      password: { mode: 'set' as const, value: 'spring2026' },
    }
    expect(inputOf(s, ADL)).toEqual({
      host: 'go.example.test',
      slug: 'spring',
      name: 'Spring offer',
      targets: [
        { url: 'https://example.com/a', weight: 70 },
        { url: 'https://example.com/b', weight: 30 },
      ],
      backupUrl: 'https://example.com/backup',
      deviceUrls: { ios: 'https://example.com/ios' },
      countries: { mode: 'block', list: ['US', 'CA'] },
      clickCap: 1000,
      expiresAt: '2026-11-11T13:30:00.000Z',
      passthrough: false,
      trafficActions: { bot: 'block', datacenter: 'safe' },
      password: 'spring2026',
    })
  })

  it('sends a password when it is the only thing set beyond the target', () => {
    const s = {
      ...blankForm('go.example.test'),
      targets: [{ url: 'https://example.com/offer', weight: '100' }],
      password: { mode: 'set' as const, value: 'spring2026' },
    }
    expect(inputOf(s, ADL)).toEqual({
      host: 'go.example.test',
      targets: [{ url: 'https://example.com/offer' }],
      password: 'spring2026',
    })
  })
})

describe('editing a link', () => {
  const before = formOf(LINK, ADL)

  it('reads a link into the form', () => {
    expect(before).toEqual({
      host: 'go.example.test',
      slug: 'spring',
      name: 'Spring offer',
      enabled: true,
      targets: [{ url: 'https://example.com/offer', weight: '100' }],
      backupUrl: '',
      deviceUrls: { ios: 'https://example.com/ios', android: '', desktop: '' },
      returningUrl: '',
      countryMode: 'all',
      countryList: '',
      clickCap: '1000',
      expiresAt: '2026-11-12T00:00',
      passthrough: true,
      trafficActions: {
        bot: 'inherit',
        abuser: 'inherit',
        anonymous: 'inherit',
        datacenter: 'inherit',
      },
      password: { mode: 'keep', value: '' },
    })
  })

  // A password-protected link, renamed. The body is the name and only the name:
  // no password key, so the password stays.
  it('sends only the name when only the name changed', () => {
    expect(patchOf(before, { ...before, name: 'Autumn offer' }, ADL)).toEqual({
      name: 'Autumn offer',
    })
  })

  it('sends nothing when nothing changed', () => {
    expect(patchOf(before, { ...before }, ADL)).toEqual({})
  })

  it('clears a name by sending null', () => {
    expect(patchOf(before, { ...before, name: '' }, ADL)).toEqual({ name: null })
  })

  it('sets a password, and removes one, only when asked to', () => {
    expect(
      patchOf(before, { ...before, password: { mode: 'set', value: 'new-secret' } }, ADL),
    ).toEqual({
      password: 'new-secret',
    })
    expect(patchOf(before, { ...before, password: { mode: 'remove', value: '' } }, ADL)).toEqual({
      password: null,
    })
    expect(
      patchOf(before, { ...before, password: { mode: 'keep', value: 'typed then kept' } }, ADL),
    ).toEqual({})
  })

  it('sends every target when any of them changed, with weights once there are several', () => {
    const after = {
      ...before,
      targets: [
        { url: 'https://example.com/offer', weight: '60' },
        { url: 'https://example.com/other', weight: '40' },
      ],
    }
    expect(patchOf(before, after, ADL)).toEqual({
      targets: [
        { url: 'https://example.com/offer', weight: 60 },
        { url: 'https://example.com/other', weight: 40 },
      ],
    })
  })

  it('sends the device URLs whole, without the ones emptied', () => {
    const after = {
      ...before,
      deviceUrls: { ios: '', android: 'https://example.com/android', desktop: '' },
    }
    expect(patchOf(before, after, ADL)).toEqual({
      deviceUrls: { android: 'https://example.com/android' },
    })
  })

  it('clears a cap and an expiry by sending null', () => {
    expect(patchOf(before, { ...before, clickCap: '', expiresAt: '' }, ADL)).toEqual({
      clickCap: null,
      expiresAt: null,
    })
  })

  it('sends the countries as a rule', () => {
    expect(
      patchOf(before, { ...before, countryMode: 'allow', countryList: 'de,FR ' }, ADL),
    ).toEqual({
      countries: { mode: 'allow', list: ['DE', 'FR'] },
    })
  })
})

describe('what the form refuses before asking', () => {
  const ok = {
    ...blankForm('go.example.test'),
    targets: [{ url: 'https://example.com/a', weight: '100' }],
  }

  it('refuses nothing in a plain link', () => expect(problemsOf(ok)).toEqual({}))

  it.each([
    [
      'a cap of zero',
      { clickCap: '0' },
      { clickCap: 'A click cap is a whole number of clicks, at least 1.' },
    ],
    [
      'a cap that is not a number',
      { clickCap: 'lots' },
      { clickCap: 'A click cap is a whole number of clicks, at least 1.' },
    ],
    [
      'weights that do not add up',
      {
        targets: [
          { url: 'https://example.com/a', weight: '70' },
          { url: 'https://example.com/b', weight: '20' },
        ],
      },
      { targets: 'Weights add up to 90; they must add up to 100.' },
    ],
    [
      'a weight that is not a whole number',
      {
        targets: [
          { url: 'https://example.com/a', weight: '50.5' },
          { url: 'https://example.com/b', weight: '49.5' },
        ],
      },
      { targets: 'A weight is a whole number from 1 to 100.' },
    ],
    [
      'a country that is not a code',
      { countryMode: 'allow' as const, countryList: 'DE, Germany' },
      { countries: '“GERMANY” is not a two-letter country code.' },
    ],
    [
      'a rule with no countries',
      { countryMode: 'block' as const, countryList: ' ' },
      { countries: 'Name at least one country.' },
    ],
    [
      'a password shorter than six characters',
      { password: { mode: 'set' as const, value: 'abc' } },
      { password: 'A link password is at least 6 characters.' },
    ],
  ])('refuses %s', (_label, change, problems) => {
    expect(problemsOf({ ...ok, ...change })).toEqual(problems)
  })

  it('does not count a single target’s weight', () => {
    expect(problemsOf({ ...ok, targets: [{ url: 'https://example.com/a', weight: '' }] })).toEqual(
      {},
    )
  })
})

describe('the service’s refusal, field by field', () => {
  it('puts each part of the message under the field its path names', () => {
    expect(
      fieldErrors(
        'targets.1.url: must be an absolute http or https URL; backupUrl: must be printable ASCII',
      ),
    ).toEqual({
      'targets.1': 'must be an absolute http or https URL',
      backupUrl: 'must be printable ASCII',
    })
  })

  // The shape the service really sends for a refusal of the whole link.
  it('puts a refusal of the whole link under the form', () => {
    expect(fieldErrors('link: target weights must sum to 100, got 90')).toEqual({
      form: 'target weights must sum to 100, got 90',
    })
  })

  it('keeps a part with no path for the form as a whole', () => {
    expect(fieldErrors('something went wrong')).toEqual({ form: 'something went wrong' })
  })
})
