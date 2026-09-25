/**
 * Horizontal bars for a breakdown: each row's label, its bar as a share of the
 * largest row, and its numbers. The bar's width is a React style, which the
 * browser sets through the CSSOM rather than as an inline style attribute, so
 * the security policy does not govern it.
 */
export function Bars({
  rows,
}: { rows: { key: string; label: string; value: number; secondary: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground" title={r.label}>
              {r.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{r.secondary}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
