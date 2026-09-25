import { PageHeader } from '@/app/PageHeader'
import { Link } from 'react-router'

export function NotFound() {
  return (
    <div className="grid gap-4">
      <PageHeader title="Nothing here" description="There is no screen at this address." />
      <Link to="/overview" className="text-sm text-primary underline">
        Go to the overview
      </Link>
    </div>
  )
}
