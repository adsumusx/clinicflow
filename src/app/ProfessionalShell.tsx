import type { ReactNode } from 'react'
import { useAuth } from '@/features/auth'
import './ProfessionalShell.css'

export type NavigationId = 'dashboard' | 'agenda' | 'clients' | 'leads' | 'resources' | 'finance' | 'reports' | 'more'

interface ProfessionalShellProps {
  activeNavigationId?: NavigationId
  children: ReactNode
}

interface NavigationItem {
  href: string
  icon: NavigationId
  id: NavigationId
  label: string
}

const navigationItems: NavigationItem[] = [
  { href: '#dashboard', icon: 'dashboard', id: 'dashboard', label: 'Dashboard' },
  { href: '#agenda', icon: 'agenda', id: 'agenda', label: 'Agenda' },
  { href: '#clients', icon: 'clients', id: 'clients', label: 'Clientes' },
  { href: '#leads', icon: 'leads', id: 'leads', label: 'Prospecções' },
  { href: '#resources', icon: 'resources', id: 'resources', label: 'Recursos' },
  { href: '#finance', icon: 'finance', id: 'finance', label: 'Financeiro' },
  { href: '#reports', icon: 'reports', id: 'reports', label: 'Relatórios' },
  { href: '#more', icon: 'more', id: 'more', label: 'Mais' },
]

function NavigationIcon({ name }: { name: NavigationId }) {
  const commonProps = {
    'aria-hidden': true,
    className: 'navigation-icon',
    fill: 'none',
    focusable: false,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
    viewBox: '0 0 24 24',
  }

  if (name === 'dashboard') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    )
  }

  if (name === 'agenda') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 10h18" />
      </svg>
    )
  }

  if (name === 'clients') {
    return (
      <svg {...commonProps}>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M15 5.5a3 3 0 0 1 0 5.8M16 14c2.7.3 4.1 2.2 4.5 5" />
      </svg>
    )
  }

  if (name === 'leads') {
    return (
      <svg {...commonProps}>
        <path d="M4 5h16M6 10h12M9 15h6M11 20h2" />
      </svg>
    )
  }

  if (name === 'finance') {
    return (
      <svg {...commonProps}>
        <path d="M3 7.5h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h12" />
        <path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z" />
      </svg>
    )
  }

  if (name === 'resources') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="4" width="8" height="7" rx="1" />
        <rect x="13" y="4" width="8" height="7" rx="1" />
        <rect x="3" y="13" width="8" height="7" rx="1" />
        <path d="M17 13v7M13.5 16.5h7" />
      </svg>
    )
  }

  if (name === 'reports') {
    return (
      <svg {...commonProps}>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    )
  }

  return (
    <svg {...commonProps}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function Brand() {
  return (
    <a className="professional-brand" href="#dashboard" aria-label="ClinicFlow, ir para o Dashboard">
      <span className="professional-brand__mark" aria-hidden="true">
        CF
      </span>
      <span className="professional-brand__copy">
        <strong>ClinicFlow</strong>
        <small>Gestão clínica integrada</small>
      </span>
    </a>
  )
}

function ProfileButton({ compact = false }: { compact?: boolean }) {
  const { logout, session } = useAuth()
  const email = session?.user.email ?? ''
  const initials = email.slice(0, 2).toUpperCase()
  return (
    <button
      className={`profile-button${compact ? ' profile-button--compact' : ''}`}
      type="button"
      aria-label={`Sair da conta ${email}`}
      onClick={() => void logout()}
    >
      <span className="profile-button__avatar" aria-hidden="true">
        {initials}
      </span>
      {!compact && (
        <span className="profile-button__copy">
          <strong>{email}</strong>
          <small>Sair da conta</small>
        </span>
      )}
    </button>
  )
}

export function ProfessionalShell({
  activeNavigationId = 'dashboard',
  children,
}: ProfessionalShellProps) {
  const { session, selectOrganization } = useAuth()
  const activeOrganization = session?.organizations.find(
    (organization) => organization.id === session.organizationId,
  )

  return (
    <div className="professional-shell">
      <a className="skip-link" href="#main-content">
        Pular para o conteúdo
      </a>

      <header className="professional-shell__mobile-header">
        <Brand />
        <select
          className="mobile-organization-selector"
          aria-label="Organização ativa"
          value={session?.organizationId ?? ''}
          onChange={(event) => void selectOrganization(event.target.value)}
        >
          {session?.organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>{organization.name}</option>
          ))}
        </select>
        <ProfileButton compact />
      </header>

      <aside className="professional-sidebar">
        <div className="professional-sidebar__brand">
          <Brand />
        </div>

        <nav className="primary-navigation" aria-label="Navegação principal">
          <ul className="primary-navigation__list">
            {navigationItems.map((item) => {
              const isActive = item.id === activeNavigationId

              return (
                <li key={item.id}>
                  <a
                    className={`primary-navigation__link${isActive ? ' primary-navigation__link--active' : ''}`}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <NavigationIcon name={item.icon} />
                    <span>{item.label}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="professional-sidebar__context">
          <label className="professional-sidebar__context-label" htmlFor="organization-selector">
            Organização ativa
          </label>
          <select
            id="organization-selector"
            value={session?.organizationId ?? ''}
            onChange={(event) => void selectOrganization(event.target.value)}
          >
            {session?.organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>{organization.name}</option>
            ))}
          </select>
          <span>{activeOrganization?.roleName}</span>
        </div>
      </aside>

      <div className="professional-shell__workspace">
        <header className="professional-topbar">
          <div>
            <span className="professional-topbar__eyebrow">Visão profissional</span>
            <strong>{activeOrganization?.name}</strong>
          </div>
          <ProfileButton />
        </header>

        <main id="main-content" className="professional-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}
