import type { Link } from '@/api/types'
import { describe, expect, it } from 'vitest'
import { linkFacts } from './linkFacts'

const ADL = 'Australia/Adelaide'
const NOW = Date.parse('2026-10-07T03:00:00.000Z')

const link = (over: Partial<Link> = {}): Link => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  domainId: '00000000-0000-4000-8000-00000000000d',
  host: 'go.example.test',
  slug: 'spring',
  url: 'https://go.example.test/spring',
  name: null,
  enabled: true,
  targets: [{ id: 't1', url: 'https://example.com/offer', weight: 100 }],
  backupUrl: null,
  deviceUrls: {},
  returningUrl: null,
  countries: { mode: 'all' },
  clickCap: null,
  capUsed: null,
  expiresAt: null,
  passthrough: true,
  trafficActions: {},
  hasPassword: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

describe('what a link says about itself', () => {
  it('says nothing for a plain link', () => {
    expect(linkFacts(link(), NOW, ADL)).toEqual({ status: [], rules: [] })
  })

  it('says it is disabled, and that a disabled link answers as an unknown slug', () => {
    expect(linkFacts(link({ enabled: false }), NOW, ADL).status).toEqual([
      'Disabled: answers as an unknown slug',
    ])
  })

  it('says how much of a cap is used, and that a reached cap sends visitors to the backup', () => {
    expect(linkFacts(link({ clickCap: 1000, capUsed: 312 }), NOW, ADL).status).toEqual([
      '312 of 1,000 clicks used',
    ])
    expect(linkFacts(link({ clickCap: 1000, capUsed: 1000 }), NOW, ADL).status).toEqual([
      'Cap reached: 1,000 of 1,000 clicks',
    ])
  })

  // A cap of zero is a link switched off by its cap rather than one with no
  // cap at all (that is `clickCap: null`, tested above): `0 >= 0` is already
  // reached, on the very first click.
  it('says a cap of zero is already reached', () => {
    expect(linkFacts(link({ clickCap: 0, capUsed: 0 }), NOW, ADL).status).toEqual([
      'Cap reached: 0 of 0 clicks',
    ])
  })

  it('says when it expires, and when it expired, in local time', () => {
    expect(linkFacts(link({ expiresAt: '2026-11-11T13:30:00.000Z' }), NOW, ADL).status).toEqual([
      'Expires 12 Nov 2026, 00:00',
    ])
    expect(linkFacts(link({ expiresAt: '2026-10-02T23:30:00.000Z' }), NOW, ADL).status).toEqual([
      'Expired 3 Oct 2026, 09:00',
    ])
  })

  // The boundary itself: an expiry at exactly this instant is already past,
  // not still upcoming — `<=`, not `<`. A mutation that loosens the
  // comparison to `<` would call this link still live at the moment it dies.
  it('says a link expiring at exactly this moment has already expired', () => {
    expect(linkFacts(link({ expiresAt: '2026-10-07T03:00:00.000Z' }), NOW, ADL).status).toEqual([
      'Expired 7 Oct 2026, 13:30',
    ])
  })

  // Three status facts at once, in the order the code checks them — disabled,
  // then the cap, then the expiry — so a reorder is a visible change here even
  // though every individual fact is already covered above.
  it('lists disabled, capped and expired together in that order', () => {
    expect(
      linkFacts(
        link({
          enabled: false,
          clickCap: 100,
          capUsed: 100,
          expiresAt: '2026-10-02T23:30:00.000Z',
        }),
        NOW,
        ADL,
      ).status,
    ).toEqual([
      'Disabled: answers as an unknown slug',
      'Cap reached: 100 of 100 clicks',
      'Expired 3 Oct 2026, 09:00',
    ])
  })

  it('names its rules', () => {
    const f = linkFacts(
      link({
        hasPassword: true,
        countries: { mode: 'allow', list: ['DE', 'FR'] },
        passthrough: false,
        trafficActions: { bot: 'block' },
        targets: [
          { id: 't1', url: 'https://example.com/a', weight: 70 },
          { id: 't2', url: 'https://example.com/b', weight: 30 },
        ],
      }),
      NOW,
      ADL,
    )
    expect(f.rules).toEqual([
      'Password',
      'Rotates between 2 targets',
      'Countries: only Germany, France',
      'Query string not passed on',
      'Own traffic actions',
    ])
  })

  it('names a blocking country rule', () => {
    expect(linkFacts(link({ countries: { mode: 'block', list: ['US'] } }), NOW, ADL).rules).toEqual(
      ['Countries: all but United States'],
    )
  })
})
