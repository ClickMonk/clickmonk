import { NotFound } from '@/screens/NotFound'
import { LinkReport } from '@/screens/links/LinkReport'
import { Links } from '@/screens/links/Links'
import { Overview } from '@/screens/overview/Overview'
import { Navigate, Route, Routes } from 'react-router'
import { PageHeader } from './PageHeader'

/** A screen not built yet. Each screen's own task replaces its line below, and nothing else. */
function Placeholder({ title }: { title: string }) {
  return <PageHeader title={title} />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<Overview />} />
      <Route path="/links" element={<Links />} />
      <Route path="/links/new" element={<Placeholder title="New link" />} />
      <Route path="/links/:id" element={<LinkReport />} />
      <Route path="/links/:id/edit" element={<Placeholder title="Edit link" />} />
      <Route path="/clicks" element={<Placeholder title="Clicks" />} />
      <Route path="/domains" element={<Placeholder title="Domains" />} />
      <Route path="/settings" element={<Placeholder title="Settings" />} />
      <Route path="/account" element={<Placeholder title="Account" />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
