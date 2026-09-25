import type { ReportWindow } from '@/api/types'
import { browserZone } from '@/app/clock'
import { dayStartNote, describeSpan } from './range'

/**
 * What a report actually counted: the window from its response, which the
 * service may have widened to whole hours or days, in local time and with the
 * zone named. And, for a day chart whose days do not all begin at local
 * midnight, the sentence that says where they begin.
 */
export function CountedWindow({
  counted,
  bucket,
}: { counted: ReportWindow; bucket?: 'hour' | 'day' }) {
  const timeZone = browserZone()
  const span = { fromMs: Date.parse(counted.from), toMs: Date.parse(counted.to) }
  const note = bucket === 'day' ? dayStartNote(span, timeZone) : null
  return (
    <div className="text-sm text-muted-foreground">
      <p>{`Counted ${describeSpan(span, timeZone)} (${timeZone})`}</p>
      {note && <p>{note}</p>}
    </div>
  )
}
