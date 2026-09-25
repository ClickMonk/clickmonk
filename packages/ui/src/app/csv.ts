/**
 * A CSV of what is already on screen — a breakdown, the chart's buckets, the
 * summary — written by the browser. Every cell quoted, a quote doubled, CRLF
 * line ends, no BOM, and a text cell a spreadsheet would run as a formula (a
 * leading =, +, - or @, or whitespace before one) prefixed with an apostrophe
 * so it is shown rather than run. Numbers are written as numbers — a count
 * this page holds is not text anyone chose, and -5 must open as -5 — which is
 * where this differs from the service's export: every cell there is text read
 * from the store, and the service guards them all.
 */

type Cell = string | number | boolean | null

const FORMULA = /^[\s]*[=+\-@]/

export function csvCell(value: Cell): string {
  if (value === null) return '""'
  const text = String(value)
  const safe = typeof value === 'string' && FORMULA.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => `${r.map(csvCell).join(',')}\r\n`).join('')
}

/** Saves a CSV through a temporary object URL, which is revoked straight after. */
export function downloadCsv(filename: string, rows: Cell[][]): void {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
