import { describe, expect, it } from 'vitest'
import { readFilters, writeFilters } from './filters'

describe('the filters in the address', () => {
  it('reads every filter it knows', () => {
    expect(
      readFilters(
        new URLSearchParams(
          'link=00000000-0000-4000-8000-0000000000a1&class=bot&outcome=blocked&country=DE&range=7d',
        ),
      ),
    ).toEqual({
      filters: {
        link: '00000000-0000-4000-8000-0000000000a1',
        class: 'bot',
        outcome: 'blocked',
        country: 'DE',
      },
      problem: null,
    })
  })

  it('reads nothing as no filters', () => {
    expect(readFilters(new URLSearchParams('range=today'))).toEqual({ filters: {}, problem: null })
  })

  it.each([
    ['a class nobody has', 'class=robot'],
    ['an outcome nobody has', 'outcome=maybe'],
    ['a country in lower case', 'country=de'],
    ['a country with a trailing letter', 'country=DEX'],
    ['a link that is not an id', 'link=spring'],
  ])('drops %s and says so', (_label, query) => {
    expect(readFilters(new URLSearchParams(query))).toEqual({
      filters: {},
      problem: 'A filter in this address could not be used and was left out.',
    })
  })

  it('writes filters beside the window, and removes the ones cleared', () => {
    const next = writeFilters(new URLSearchParams('range=7d&class=bot&country=DE'), {
      class: 'human',
    })
    expect(next.toString()).toBe('range=7d&class=human')
  })
})
