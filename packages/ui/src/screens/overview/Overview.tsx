import { PageHeader } from '@/app/PageHeader'
import { WindowPicker } from '@/window/WindowPicker'
import { OVERVIEW_PANELS, Report } from './Report'

export function Overview() {
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Overview"
        description="Every link on every domain."
        actions={<WindowPicker />}
      />
      <Report panels={OVERVIEW_PANELS} />
    </div>
  )
}
