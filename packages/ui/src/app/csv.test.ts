import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csv'

// The same rules the service's own export follows: every cell quoted, a quote
// doubled, and a cell a spreadsheet would run as a formula made inert.
describe('a CSV cell', () => {
  it.each([
    ['plain', '"plain"'],
    ['with "quotes"', '"with ""quotes"""'],
    ['a,b', '"a,b"'],
    ['two\nlines', '"two\nlines"'],
    ['=SUM(A1)', `"'=SUM(A1)"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@cmd', `"'@cmd"`],
    [' =1', `"' =1"`],
    ['\t=1', `"'\t=1"`],
    ['a=b', '"a=b"'],
  ])('writes %j as %s', (value, cell) => expect(csvCell(value)).toBe(cell))

  it('writes a number as itself, not as a formula', () => expect(csvCell(-5)).toBe('"-5"'))
  it('writes nothing for null', () => expect(csvCell(null)).toBe('""'))
  it('writes a boolean as a word', () => expect(csvCell(true)).toBe('"true"'))
})

describe('a CSV file', () => {
  it('ends every line with CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['1', null],
      ]),
    ).toBe('"a","b"\r\n"1",""\r\n')
  })
})
