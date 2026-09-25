import { formatNumber } from '@/app/format'
import { columns } from './columns'

const BOX = { width: 600, height: 160, gap: 2 }

/**
 * Columns over time. Drawn by hand from `columns()`; every rectangle carries
 * its label and value as a native tooltip, the chart as a whole a sentence for
 * a screen reader, and the same numbers are in a table on request.
 *
 * Coloured from the theme only: `var(--color-primary)` for the columns and the
 * border role for the axis, which is what makes it follow the theme and pass
 * the source rules.
 */
export function Columns({
  buckets,
  unit,
  label,
  span,
}: {
  buckets: { label: string; value: number }[]
  unit: 'clicks' | 'visitors'
  label: string
  span: 'hour' | 'day'
}) {
  const g = columns(
    buckets.map((b) => b.value),
    BOX,
  )
  const total = buckets.reduce((n, b) => n + b.value, 0)
  const top = buckets.reduce<{ label: string; value: number } | null>(
    (m, b) => (m === null || b.value > m.value ? b : m),
    null,
  )
  const most = top && top.value > 0 ? `, the most ${formatNumber(top.value)} on ${top.label}` : ''
  const spans = `over ${buckets.length} ${span}${buckets.length === 1 ? '' : 's'}`
  // Visitors are counted per bar (a returning visitor is one visitor in each
  // bar they appear in), so a total across bars would be wrong in the same
  // way the caveat under the chart warns against — the sentence names the
  // buckets and the peak, never a sum, when the metric is visitors.
  const sentence =
    unit === 'visitors'
      ? `${label}, ${spans}${most}`
      : `${label}: ${formatNumber(total)} ${unit} ${spans}${most}`
  const Unit = unit === 'clicks' ? 'Clicks' : 'Visitors'
  return (
    <figure className="grid gap-2">
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <div
          data-testid="axis"
          className="flex flex-col justify-between text-right text-xs text-muted-foreground"
        >
          <span>{formatNumber(g.max)}</span>
          <span>{formatNumber(g.max / 2)}</span>
          <span>0</span>
        </div>
        <svg
          role="img"
          aria-label={sentence}
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          preserveAspectRatio="none"
          className="h-40 w-full"
        >
          <line
            x1="0"
            x2={BOX.width}
            y1={BOX.height}
            y2={BOX.height}
            stroke="var(--color-border)"
            vectorEffect="non-scaling-stroke"
          />
          {g.bars.map((b, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional and never reorder
              key={i}
              data-bucket={i}
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              fill="var(--color-primary)"
            >
              <title>{`${buckets[i]?.label}: ${formatNumber(buckets[i]?.value ?? 0)} ${unit}`}</title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="flex justify-between pl-8 text-xs text-muted-foreground">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show the numbers</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                When
              </th>
              <th scope="col">{Unit}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional and never reorder; two buckets can share a label (a clock change), and the label is not a stable identity.
              <tr key={i}>
                <td>{b.label}</td>
                <td className="tabular-nums">{formatNumber(b.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
