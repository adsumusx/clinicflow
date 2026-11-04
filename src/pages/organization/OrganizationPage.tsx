import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, apiRequest, useAuth } from '@/features/auth'
import { Button, Card, EmptyState, LoadingState, QrCode } from '@/shared/ui'
import './OrganizationPage.css'

interface Membership {
  id: string
  email: string
  roleCode: string
  roleName: string
  status: 'active' | 'invited'
  professionalId?: string | null
  professionalName?: string | null
  registrationNumber?: string | null
  inviteToken?: string | null
  inviteUrl?: string | null
}

export function OrganizationPage() {
  const { session } = useAuth()
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [editingProf, setEditingProf] = useState<{ id: string; name: string; reg: string } | null>(null)
  const [savingProf, setSavingProf] = useState(false)
  const [activeInvite, setActiveInvite] = useState<{
    email?: string
    roleName?: string
    inviteUrl: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const permissions = organization?.permissions ?? []
  const canReadMemberships = permissions.includes('memberships.read')
  const canManageMemberships = permissions.includes('memberships.manage')
  const canManagePrivilegedRoles = permissions.includes('roles.manage_privileged')

  async function loadMemberships() {
    if (!session?.organizationId || !canReadMemberships) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setMemberships(await apiRequest<Membership[]>(`/api/organizations/${session.organizationId}/memberships`))
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setMemberships([])
      else setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a equipe.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadMemberships()
  }, [session?.organizationId, canReadMemberships, canManageMemberships])

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    const form = event.currentTarget
    const data = new FormData(form)
    const email = String(data.get('email') || '').trim() || undefined
    const roleCode = String(data.get('roleCode'))
    try {
      const response = await apiRequest<{
        id: string
        status: string
        token?: string
        inviteUrl?: string
      }>(`/api/organizations/${session.organizationId}/memberships`, {
        method: 'POST',
        body: JSON.stringify({ email, roleCode }),
      })
      form.reset()
      setMessage('Convite registrado com sucesso.')

      const fullInviteUrl = response.token
        ? `${window.location.origin}/#register?invite=${encodeURIComponent(response.token)}`
        : response.inviteUrl
          ? `${window.location.origin}${response.inviteUrl}`
          : ''

      if (fullInviteUrl) {
        setActiveInvite({
          email,
          roleName: roleCode === 'admin' ? 'Administrador' : roleCode === 'professional' ? 'Profissional' : roleCode === 'reception_finance' ? 'Recepção/Financeiro' : 'Cliente',
          inviteUrl: fullInviteUrl,
        })
      }
      await loadMemberships()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível registrar o convite.')
    }
  }

  async function revoke(membershipId: string) {
    if (!session?.organizationId) return
    try {
      await apiRequest(`/api/organizations/${session.organizationId}/memberships/${membershipId}`, { method: 'DELETE' })
      setMessage('Vínculo revogado.')
      if (activeInvite) setActiveInvite(null)
      await loadMemberships()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível revogar o vínculo.')
    }
  }

  async function saveProfessionalRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || !editingProf) return
    setSavingProf(true)
    try {
      await apiRequest(`/api/organizations/${session.organizationId}/professionals/${editingProf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ registrationNumber: editingProf.reg, displayName: editingProf.name }),
      })
      setMessage('Registro profissional (CREFITO/similar) atualizado com sucesso.')
      setEditingProf(null)
      await loadMemberships()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar o registro profissional.')
    } finally {
      setSavingProf(false)
    }
  }

  return (
    <section className="organization-page" aria-labelledby="organization-title">
      <header className="organization-page__header">
        <div>
          <span>Configurações</span>
          <h1 id="organization-title">Organização e equipe</h1>
          <p>{organization?.name} · {organization?.roleName}</p>
        </div>
      </header>

      {message && <p className="organization-page__message" role="status">{message}</p>}

      <div className="organization-page__grid">
        {canManageMemberships && (
          <Card title="Convidar pessoa" description="Gere um link e QR Code para a pessoa criar a conta dela nesta clínica.">
            <form className="organization-form" onSubmit={invite}>
              <label>
                E-mail (opcional)
                <input name="email" type="email" autoComplete="email" placeholder="nome@exemplo.com" />
              </label>
              <label>Função
                <select name="roleCode" defaultValue="professional">
                  {canManagePrivilegedRoles && <option value="admin">Administrador</option>}
                  <option value="professional">Profissional</option>
                  <option value="reception_finance">Recepção/Financeiro</option>
                  <option value="client">Cliente</option>
                </select>
              </label>
              <Button type="submit">Gerar convite e QR Code</Button>
            </form>
          </Card>
        )}
      </div>

      {activeInvite && (
        <Card
          title={`Link e QR Code de convite: ${activeInvite.roleName ?? 'Novo membro'}`}
          description="A pessoa pode escanear o QR Code pela câmera do celular ou acessar o link para concluir o cadastro."
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '1rem 0' }}>
            {activeInvite.email && (
              <p style={{ margin: 0, color: 'var(--color-on-surface-variant, #64748b)' }}>
                Destinado a: <strong>{activeInvite.email}</strong>
              </p>
            )}
            <QrCode value={activeInvite.inviteUrl} size={200} title="Aponte a câmera para criar a conta" />
            <div style={{ width: '100%', maxWidth: '480px', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                readOnly
                value={activeInvite.inviteUrl}
                style={{
                  flex: 1,
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.875rem',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--color-outline-variant, #cbd5e1)',
                }}
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <Button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(activeInvite.inviteUrl)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? 'Copiado!' : 'Copiar link'}
              </Button>
            </div>
            <Button variant="secondary" type="button" onClick={() => setActiveInvite(null)}>
              Fechar QR Code
            </Button>
          </div>
        </Card>
      )}

      {editingProf && (
        <Card title={`Registro profissional: ${editingProf.name}`} description="Informe o número de conselho (ex: CREFITO, CRM, CREF) para constar no prontuário.">
          <form className="organization-form" onSubmit={saveProfessionalRegistration}>
            <label>
              Nome de exibição
              <input
                value={editingProf.name}
                required
                onChange={(e) => setEditingProf({ ...editingProf, name: e.target.value })}
              />
            </label>
            <label>
              Registro no conselho (CREFITO ou similar)
              <input
                value={editingProf.reg}
                placeholder="Ex: CREFITO-3/12345-F ou CRM-SP 123456"
                onChange={(e) => setEditingProf({ ...editingProf, reg: e.target.value })}
              />
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <Button type="submit" disabled={savingProf}>
                {savingProf ? 'Salvando…' : 'Salvar registro'}
              </Button>
              <Button type="button" variant="secondary" disabled={savingProf} onClick={() => setEditingProf(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Equipe e vínculos" description="Somente vínculos ativos ou convidados desta organização aparecem aqui.">
        {loading ? <LoadingState title="Carregando equipe…" /> : !canReadMemberships ? (
          <EmptyState title="Acesso restrito" description="Sua função não permite consultar os vínculos desta organização." />
        ) : memberships.length === 0 ? <EmptyState title="Nenhum vínculo encontrado" /> : (
          <ul className="membership-list">
            {memberships.map((membership) => (
              <li key={membership.id}>
                <span>
                  <strong>{membership.email}</strong>
                  <small>
                    {membership.professionalName ? `${membership.professionalName} · ` : ''}
                    {membership.roleName} · {membership.status === 'active' ? 'Ativo' : 'Convidado'}
                  </small>
                  {membership.registrationNumber ? (
                    <small style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                      Registro: {membership.registrationNumber}
                    </small>
                  ) : membership.roleCode === 'professional' ? (
                    <small style={{ color: 'var(--color-outline)' }}>
                      Sem CREFITO cadastrado
                    </small>
                  ) : null}
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {canManageMemberships && membership.status === 'invited' && membership.inviteToken && (
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => {
                        setActiveInvite({
                          email: membership.email,
                          roleName: membership.roleName,
                          inviteUrl: `${window.location.origin}/#register?invite=${encodeURIComponent(membership.inviteToken!)}`,
                        })
                      }}
                    >
                      QR Code / Link
                    </Button>
                  )}
                  {canManageMemberships && membership.professionalId && (
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => setEditingProf({
                        id: membership.professionalId!,
                        name: membership.professionalName || membership.email.split('@')[0],
                        reg: membership.registrationNumber || '',
                      })}
                    >
                      Editar CREFITO/Registro
                    </Button>
                  )}
                  {canManageMemberships && membership.email !== session?.user.email && (
                    <Button variant="secondary" type="button" onClick={() => void revoke(membership.id)}>Revogar</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}
