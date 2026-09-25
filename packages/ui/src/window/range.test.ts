import { describe, expect, it } from 'vitest'
import {
  bucketFor,
  bucketLabel,
  choiceParams,
  dayOffsetHours,
  dayStartNote,
  describeSpan,
  parseChoice,
  spanOf,
  startOfDate,
  windowDatesSlug,
  zoneOffsetMinutes,
} from './range'

const ADL = 'Australia/Adelaide'
const at = (iso: string) => Date.parse(iso)
const iso = (s: { fromMs: number; toMs: number }) => [
  new Date(s.fromMs).toISOString(),
  new Date(s.toMs).toISOString(),
]
/** 13:30 on Wednesday 7 October 2026 in Adelaide, three days after its clocks went forward. */
const NOW = at('2026-10-07T03:00:00.000Z')

describe('a zone’s offset', () => {
  it('reads Adelaide either side of its clock change', () => {
    expect(zoneOffsetMinutes(at('2026-10-01T00:00:00Z'), ADL)).toBe(570)
    expect(zoneOffsetMinutes(NOW, ADL)).toBe(630)
  })
})

describe('where a local day begins', () => {
  // 4 October 2026 is the day Adelaide's clocks go forward at two in the
  // morning: it begins at +9:30 and the next begins at +10:30, so it is
  // twenty-three hours long.
  it('handles a day that is twenty-three hours long', () => {
    expect(new Date(startOfDate('2026-10-04', ADL)).toISOString()).toBe('2026-10-03T14:30:00.000Z')
    expect(new Date(startOfDate('2026-10-05', ADL)).toISOString()).toBe('2026-10-04T13:30:00.000Z')
  })

  it('handles a day that is twenty-five hours long', () => {
    const ny = 'America/New_York'
    expect(new Date(startOfDate('2026-11-01', ny)).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(new Date(startOfDate('2026-11-02', ny)).toISOString()).toBe('2026-11-02T05:00:00.000Z')
  })

  // Havana and Cairo move their clocks at midnight, so these days have no
  // midnight and begin at 01:00 local, the moment the clocks change. Havana
  // goes from −5 to −4, Cairo from +2 to +3.
  it('begins a day whose midnight is skipped when the clocks change', () => {
    expect(new Date(startOfDate('2026-03-08', 'America/Havana')).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    )
    expect(new Date(startOfDate('2026-04-24', 'Africa/Cairo')).toISOString()).toBe(
      '2026-04-23T22:00:00.000Z',
    )
  })

  // Samoa crossed the date line by skipping 30 December 2011: 29 December
  // ended at midnight at −10 and 31 December began at +14 in the same instant.
  it('begins a day the zone skipped where the next day begins', () => {
    const apia = 'Pacific/Apia'
    expect(new Date(startOfDate('2011-12-30', apia)).toISOString()).toBe('2011-12-30T10:00:00.000Z')
    expect(new Date(startOfDate('2011-12-31', apia)).toISOString()).toBe('2011-12-30T10:00:00.000Z')
  })
})

describe('a preset', () => {
  it.each([
    ['today', ['2026-10-06T13:30:00.000Z', '2026-10-07T03:00:00.000Z']],
    ['yesterday', ['2026-10-05T13:30:00.000Z', '2026-10-06T13:30:00.000Z']],
    ['7d', ['2026-09-30T14:30:00.000Z', '2026-10-07T03:00:00.000Z']],
    ['30d', ['2026-09-07T14:30:00.000Z', '2026-10-07T03:00:00.000Z']],
    ['90d', ['2026-07-09T14:30:00.000Z', '2026-10-07T03:00:00.000Z']],
    ['12m', ['2025-10-07T13:30:00.000Z', '2026-10-07T03:00:00.000Z']],
  ] as const)('%s is the operator’s own days, in Adelaide', (preset, expected) => {
    expect(iso(spanOf({ preset }, NOW, ADL))).toEqual(expected)
  })

  it('is UTC days in UTC', () => {
    expect(iso(spanOf({ preset: 'today' }, NOW, 'UTC'))).toEqual([
      '2026-10-07T00:00:00.000Z',
      '2026-10-07T03:00:00.000Z',
    ])
  })

  it('takes two local dates, both included', () => {
    expect(iso(spanOf({ from: '2026-10-04', to: '2026-10-04' }, NOW, ADL))).toEqual([
      '2026-10-03T14:30:00.000Z',
      '2026-10-04T13:30:00.000Z',
    ])
  })
})

describe('the bucket', () => {
  it('is an hour up to three days and a day past them', () => {
    const three = { fromMs: 0, toMs: 3 * 86_400_000 }
    expect(bucketFor(three)).toBe('hour')
    expect(bucketFor({ fromMs: 0, toMs: three.toMs + 1 })).toBe('day')
  })
})

describe('the day offset', () => {
  it.each([
    ['UTC', 0],
    ['Australia/Adelaide', 10],
    ['Asia/Kolkata', 6],
    ['America/St_Johns', -2],
    ['Etc/GMT+12', -12],
    ['Pacific/Kiritimati', 14],
    ['Pacific/Chatham', 14],
  ])('in %s is %i hours', (zone, hours) => {
    expect(dayOffsetHours(spanOf({ preset: '7d' }, NOW, zone), zone)).toBe(hours)
  })
})

describe('what a day chart counted', () => {
  it('says nothing when days begin at midnight', () => {
    expect(
      dayStartNote({ fromMs: at('2026-10-01T00:00:00Z'), toMs: at('2026-10-03T00:00:00Z') }, 'UTC'),
    ).toBeNull()
  })

  it('says a half-hour zone’s days begin half an hour early', () => {
    expect(
      dayStartNote(
        { fromMs: at('2026-09-30T18:00:00Z'), toMs: at('2026-10-07T18:00:00Z') },
        'Asia/Kolkata',
      ),
    ).toBe(
      'Days are counted from 23:30 rather than midnight. Reports are kept by the hour, so a day can only begin on a whole hour of UTC.',
    )
  })

  it('says when a clock change moved where days begin', () => {
    expect(
      dayStartNote({ fromMs: at('2026-09-30T14:00:00Z'), toMs: at('2026-10-07T14:00:00Z') }, ADL),
    ).toBe(
      'Days are counted from 23:30 rather than midnight, and from 00:30 from 5 October on, after the clocks changed. Reports are kept by the hour, so a day can only begin on a whole hour of UTC.',
    )
  })

  it('says so in a whole-hour zone too, when the clocks change inside the window', () => {
    expect(
      dayStartNote(
        { fromMs: at('2026-10-26T04:00:00Z'), toMs: at('2026-11-03T04:00:00Z') },
        'America/New_York',
      ),
    ).toBe(
      'Days are counted from midnight, and from 23:00 from 2 November on, after the clocks changed. Reports are kept by the hour, so a day can only begin on a whole hour of UTC.',
    )
  })

  // A year crosses both of New York's clock changes: days begin at midnight,
  // at 23:00 from the day after the clocks go back (2 November 2025), and at
  // midnight again from the day after they go forward (8 March 2026).
  it('names every change in a year, in order', () => {
    expect(
      dayStartNote(
        { fromMs: at('2025-10-08T04:00:00Z'), toMs: at('2026-10-08T04:00:00Z') },
        'America/New_York',
      ),
    ).toBe(
      'Days are counted from midnight, from 23:00 from 3 November on, and from midnight again from 9 March on, after the clocks changed. Reports are kept by the hour, so a day can only begin on a whole hour of UTC.',
    )
  })
})

describe('labels', () => {
  it('names a day by the local date it mostly covers', () => {
    expect(bucketLabel(at('2026-09-30T14:00:00Z'), 'day', ADL)).toBe('Thu 1 Oct')
  })

  it('names an hour by its local time', () => {
    expect(bucketLabel(at('2026-10-07T00:00:00Z'), 'hour', ADL)).toBe('10:30')
  })

  it('describes a window in local time', () => {
    expect(
      describeSpan({ fromMs: at('2026-09-30T14:00:00Z'), toMs: at('2026-10-07T14:00:00Z') }, ADL),
    ).toBe('30 Sept, 23:30 – 8 Oct, 00:30')
  })

  it('names a window by its local dates for a filename, the end one before the exclusive boundary', () => {
    expect(
      windowDatesSlug({ from: '2026-09-30T14:30:00.000Z', to: '2026-10-07T03:00:00.000Z' }, ADL),
    ).toBe('2026-10-01-to-2026-10-07')
  })

  it('can name the same local date at both ends, for a window under a day', () => {
    expect(
      windowDatesSlug({ from: '2026-10-07T00:00:00.000Z', to: '2026-10-07T03:00:00.000Z' }, ADL),
    ).toBe('2026-10-07-to-2026-10-07')
  })
})

describe('the choice in the address', () => {
  it.each([
    ['range=today', { preset: 'today' }],
    ['range=12m', { preset: '12m' }],
    ['from=2026-10-01&to=2026-10-04', { from: '2026-10-01', to: '2026-10-04' }],
    ['', { preset: '7d' }],
  ])('reads %s', (query, choice) => {
    expect(parseChoice(new URLSearchParams(query))).toEqual({ choice, problem: null })
  })

  it.each([
    ['a preset nobody has', 'range=forever'],
    ['a date that is not one', 'from=2026-02-30&to=2026-03-01'],
    ['an end before its start', 'from=2026-10-04&to=2026-10-01'],
    ['more than 366 days', 'from=2025-01-01&to=2026-01-02'],
    ['a start and no end', 'from=2026-10-01'],
    ['a last day whose next day is past year 9999', 'from=9999-12-31&to=9999-12-31'],
    ['an end whose next day is past year 9999', 'from=9999-01-01&to=9999-12-31'],
  ])('falls back to the last seven days for %s, and says so', (_label, query) => {
    expect(parseChoice(new URLSearchParams(query))).toEqual({
      choice: { preset: '7d' },
      problem: 'That time range could not be used, so this shows the last 7 days.',
    })
  })

  it('takes exactly 366 days', () => {
    expect(parseChoice(new URLSearchParams('from=2024-01-01&to=2024-12-31')).problem).toBeNull()
  })

  it('writes a choice back as it reads it', () => {
    expect(choiceParams({ preset: '30d' })).toEqual({ range: '30d' })
    expect(choiceParams({ from: '2026-10-01', to: '2026-10-04' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-04',
    })
  })
})
