import { useEffect, useState } from 'react'
import { AuthProvider, AuthScreen, useAuth } from '@/features/auth'
import { AgendaPage } from '@/pages/agenda'
import { DashboardPage } from '@/pages/dashboard'
import { ClientsPage } from '@/pages/clients'
import { LeadsPage } from '@/pages/leads'
import { OrganizationPage } from '@/pages/organization'
import { ResourcesPage } from '@/pages/resources'
import { ClientAreaPage } from '@/pages/client-area'
import { FinancePage } from '@/pages/finance'
import { ReportsPage } from '@/pages/reports'
import {
  ProfessionalShell,
  type NavigationId,
} from './ProfessionalShell'
import { ClientShell } from './ClientShell'

const navigationIds: NavigationId[] = [
  'dashboard',
  'agenda',
  'clients',
  'leads',
  'resources',
  'finance',
  'reports',
  'more',
]

function getPageFromHash(): NavigationId {
  const pageId = window.location.hash.slice(1)

  return navigationIds.includes(pageId as NavigationId)
    ? (pageId as NavigationId)
    : 'dashboard'
}

function AuthenticatedApp() {
  const { loading, session } = useAuth()
  const [activePage, setActivePage] = useState<NavigationId>(getPageFromHash)
  const [openComposerRequest, setOpenComposerRequest] = useState(0)

  useEffect(() => {
    const updatePage = () => setActivePage(getPageFromHash())
    window.addEventListener('hashchange', updatePage)
    return () => window.removeEventListener('hashchange', updatePage)
  }, [])

  function openAppointmentComposer() {
    navigateTo('agenda')
    setOpenComposerRequest((request) => request + 1)
  }

  function navigateTo(destination: NavigationId) {
    window.location.hash = destination
    setActivePage(destination)
  }

  function renderActivePage() {
    if (activePage === 'agenda') {
      return <AgendaPage openComposerRequest={openComposerRequest} />
    }

    if (activePage === 'dashboard') {
      return <DashboardPage onCreateAppointment={openAppointmentComposer} />
    }

    if (activePage === 'clients') return <ClientsPage />

    if (activePage === 'leads') return <LeadsPage />

    if (activePage === 'resources') return <ResourcesPage />

    if (activePage === 'finance') return <FinancePage />

    if (activePage === 'reports') return <ReportsPage />

    if (activePage === 'more') return <OrganizationPage />

    return null
  }

  if (loading) {
    return <main className="app-loading" aria-live="polite">Carregando seu acesso…</main>
  }

  if (!session) return <AuthScreen />

  const activeOrganization = session.organizations.find(
    (organization) => organization.id === session.organizationId,
  )
  if (activeOrganization?.roleCode === 'client') {
    return <ClientShell><ClientAreaPage /></ClientShell>
  }

  return (
    <ProfessionalShell activeNavigationId={activePage}>
      {renderActivePage()}
    </ProfessionalShell>
  )
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  )
}
