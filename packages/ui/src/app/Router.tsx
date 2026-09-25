import { NotFound } from '@/screens/NotFound'
import { Clicks } from '@/screens/clicks/Clicks'
import { Domains } from '@/screens/domains/Domains'
import { LinkForm } from '@/screens/links/LinkForm'
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
      <Route path="/links/new" element={<LinkForm mode="create" />} />
      <Route path="/links/:id" element={<LinkReport />} />
      <Route path="/links/:id/edit" element={<LinkForm mode="edit" />} />
      <Route path="/clicks" element={<Clicks />} />
      <Route path="/domains" element={<Domains />} />
      <Route path="/settings" element={<Placeholder title="Settings" />} />
      <Route path="/account" element={<Placeholder title="Account" />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
