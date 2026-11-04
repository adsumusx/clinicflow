import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/features/auth'
import type { ClientAreaPageId } from '@/features/client-area'
import './ClientShell.css'

const navigation = [
  { id: 'client-home' as const, label: 'Início', symbol: '⌂' },
  { id: 'my-appointments' as const, label: 'Agendamentos', symbol: '▣' },
  { id: 'my-invoices' as const, label: 'Faturas', symbol: '$' },
  { id: 'my-content' as const, label: 'Conteúdos', symbol: '◇' },
  { id: 'contact' as const, label: 'Contato', symbol: '✆' },
  { id: 'my-profile' as const, label: 'Meu perfil', symbol: '○' },
]

const allowedPages: ClientAreaPageId[] = navigation.map(({ id }) => id)

function pageFromHash(): ClientAreaPageId {
  const candidate = window.location.hash.slice(1) as ClientAreaPageId
  return allowedPages.includes(candidate) ? candidate : 'client-home'
}

export function ClientShell({ children }: { children: ReactNode }) {
  const { logout, session, selectOrganization } = useAuth()
  const [activePage, setActivePage] = useState<ClientAreaPageId>(pageFromHash)
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)

  useEffect(() => {
    const update = () => setActivePage(pageFromHash())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  return (
    <div className="client-shell">
      <a className="skip-link" href="#client-main">Pular para o conteúdo</a>
      <header className="client-shell__header">
        <a className="client-brand" href="#client-home" aria-label="ClinicFlow, ir para o início">
          <span className="client-brand__mark" aria-hidden="true">CF</span>
          <span><strong>ClinicFlow</strong><small>{organization?.name}</small></span>
        </a>
        {session && session.organizations.length > 1 && (
          <select
            aria-label="Clínica ativa"
            value={session.organizationId ?? ''}
            onChange={(event) => void selectOrganization(event.target.value)}
          >
            {session.organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
        <button className="client-shell__logout" type="button" onClick={() => void logout()}>Sair</button>
      </header>

      <main className="client-shell__content" id="client-main" tabIndex={-1}>{children}</main>

      <nav className="client-navigation" aria-label="Navegação da área do cliente">
        {navigation.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={activePage === item.id ? 'page' : undefined}
            className={activePage === item.id ? 'client-navigation__link--active' : undefined}
          >
            <span aria-hidden="true">{item.symbol}</span>
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  )
}
