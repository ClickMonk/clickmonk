/**
 * Writing CSV, by hand, because the alternative is a dependency for two
 * functions.
 *
 * Every cell is quoted, whether it needs to be or not: a writer that decides
 * per cell is a writer with a rule to get wrong, and a reader cannot tell the
 * difference. RFC 4180 line endings, because the thing most likely to open
 * this file is a spreadsheet on Windows.
 *
 * No byte-order mark. Excel reads one as a hint about encoding; every parser
 * that does not reads it as part of the first column's name.
 */

export const CSV_EOL = '\r\n'

/**
 * A spreadsheet runs a cell that opens with one of these as a formula, and
 * quoting does not stop it — the quotes are the CSV's, and the spreadsheet
 * strips them before it looks. A click log is made of strings a stranger
 * chose: the user agent and the referrer both come from the request. So a cell
 * that opens with one is prefixed with an apostrophe, which a spreadsheet shows
 * and does not run, and which a parser reads as one more character of the
 * value. That is the trade, and it is the right way round for a file an
 * operator opens by double-clicking it.
 *
 * The three whitespace characters are in the list for one reason: a spreadsheet
 * skips leading whitespace before it decides whether a cell is a formula, so a
 * tab, a carriage return or a newline in front of an `=` hides it from a check
 * that only looks at the first character. All three, not two of them — a list
 * missing one of a set that is here for a single reason is an asymmetry somebody
 * will later read as a decision.
 */
const FORMULA_LEAD = /^[=+\-@\t\r\n]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""'
  const text = Array.isArray(value) ? value.join(' ') : String(value)
  const guarded = FORMULA_LEAD.test(text) ? `'${text}` : text
  return `"${guarded.replaceAll('"', '""')}"`
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}${CSV_EOL}`
}
