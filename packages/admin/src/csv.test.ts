import { describe, expect, it } from 'vitest'
import { csvCell, csvLine } from './csv.js'

describe('csvCell', () => {
  it.each([
    ['a plain value', 'chrome', '"chrome"'],
    ['a number', 302, '"302"'],
    ['a boolean', true, '"true"'],
    ['nothing at all', null, '""'],
    ['nothing at all, the other way', undefined, '""'],
    ['an empty string', '', '""'],
  ])('quotes %s', (_label, value, expected) => {
    expect(csvCell(value)).toBe(expected)
  })

  it('doubles a quote inside a value rather than ending the cell', () => {
    expect(csvCell('say "hello"')).toBe('"say ""hello"""')
  })

  it('keeps a comma and a newline inside the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('a\nb')).toBe('"a\nb"')
  })

  it('joins a list of tokens with spaces', () => {
    expect(csvCell(['ua_bot', 'head'])).toBe('"ua_bot head"')
    expect(csvCell([])).toBe('""')
  })

  /**
   * A click log is a file of strings a stranger chose: a user agent and a
   * referrer come from the request. A spreadsheet treats a cell opening with
   * one of these as a formula to run, and quoting does not stop it. The
   * apostrophe is visible in a spreadsheet and is part of the value to a
   * parser, which is the trade: a visible character beats a cell that runs.
   */
  it.each([
    ['=cmd|/c calc', `"'=cmd|/c calc"`],
    ['+1+1', `"'+1+1"`],
    ['-1+1', `"'-1+1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tlead', `"'\tlead"`],
    ['\rlead', `"'\rlead"`],
  ])('defuses a cell that opens with %s', (value, expected) => {
    expect(csvCell(value)).toBe(expected)
  })

  it('leaves a value that merely contains one of those alone', () => {
    expect(csvCell('a=b')).toBe('"a=b"')
  })
})

describe('csvLine', () => {
  it('joins cells with commas and ends the line the way the format says', () => {
    expect(csvLine(['a', 1, null])).toBe('"a","1",""\r\n')
  })
})
