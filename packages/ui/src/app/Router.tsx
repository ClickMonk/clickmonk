import { NotFound } from '@/screens/NotFound'
import { Account } from '@/screens/account/Account'
import { Clicks } from '@/screens/clicks/Clicks'
import { Domains } from '@/screens/domains/Domains'
import { LinkForm } from '@/screens/links/LinkForm'
import { LinkReport } from '@/screens/links/LinkReport'
import { Links } from '@/screens/links/Links'
import { Overview } from '@/screens/overview/Overview'
import { Settings } from '@/screens/settings/Settings'
import { Navigate, Route, Routes } from 'react-router'
import { useMe } from './me'

/** The account screen, reading who is signed in from the context `App` set up. */
function AccountRoute() {
  const { me, refreshMe } = useMe()
  return <Account me={me} onAccountChanged={refreshMe} />
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
      <Route path="/settings" element={<Settings />} />
      <Route path="/account" element={<AccountRoute />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
