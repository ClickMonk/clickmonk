import { describe, expect, it } from 'vitest'
import { safeHref } from './safeHref'

describe('a link from a response', () => {
  it.each(['https://example.com/offer?a=1', 'http://example.com/', 'HTTPS://example.com/'])(
    'keeps %s',
    (url) => expect(safeHref(url)).toBe(url),
  )

  it.each([
    ['a script', 'javascript:alert(1)'],
    ['a script with a capital', 'JavaScript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['a relative path', '/api/settings'],
    ['nothing', ''],
    ['null', null],
    ['not a URL', 'not a url'],
  ])('refuses %s', (_label, url) => expect(safeHref(url)).toBeUndefined())
})
