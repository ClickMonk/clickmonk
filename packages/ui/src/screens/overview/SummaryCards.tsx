import type { Summary } from '@/api/types'
import { formatNumber, formatShare } from '@/app/format'
import { Card, CardContent } from '@/components/ui/card'

/**
 * The five numbers. The human share is of all clicks; flagged and blocked are
 * the actions taken, which is what an operator acts on. Unique visitors carries
 * its caveat, once, as the product promises everywhere it is shown.
 */
export function SummaryCards({ s }: { s: Summary }) {
  const human = s.byClass.human ?? 0
  const cards: [string, string, string?][] = [
    ['Clicks', formatNumber(s.clicks)],
    ['Unique visitors', formatNumber(s.visitors), '*'],
    ['Human', formatShare(human, s.clicks)],
    ['Flagged', formatNumber(s.byAction.flag ?? 0)],
    ['Blocked', formatNumber(s.byAction.block ?? 0)],
  ]
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([term, value, mark]) => (
          <Card key={term}>
            <CardContent className="grid gap-1 p-4">
              <dt className="text-xs text-muted-foreground">
                {term}
                {mark}
              </dt>
              <dd className="font-serif text-2xl font-semibold tabular-nums text-foreground">
                {value}
              </dd>
            </CardContent>
          </Card>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        * Unique visitors count what a cookie can see: traffic that keeps no cookie — most bots,
        some privacy browsers — is one visitor per click. The number is honest about clicks and
        optimistic about people.
      </p>
    </div>
  )
}
