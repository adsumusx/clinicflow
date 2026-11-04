import { useEffect, useState, type FormEvent } from 'react'
import {
  archiveClient,
  cancelReplacementCredit,
  createClient,
  createClientClinicalRecord,
  createClientContract,
  createPlan,
  getClientProfile,
  issueReplacementCredit,
  listClients,
  listPlans,
  listReplacementCredits,
  updateClient,
  updateClientContract,
  type ClientInput,
  type ClientProfile,
  type ClientRecord,
  type ClientType,
  type PlanRecord,
  type ReplacementCreditsResponse,
} from '@/features/clients'
import { ApiError, useAuth } from '@/features/auth'
import { Button, Card, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/shared/ui'
import './ClientsPage.css'

const recordTypeLabels: Record<string, string> = {
  evolucao: 'Evolução Fisioterapêutica / Clínica',
  anamnese: 'Anamnese / Avaliação Inicial',
  consulta: 'Consulta / Atendimento',
  observacao: 'Observação Clínica',
}

const contractStatusLabels: Record<string, string> = {
  active: 'Ativo',
  draft: 'Rascunho',
  suspended: 'Suspenso',
  ended: 'Encerrado',
  cancelled: 'Cancelado',
}

function formatDay(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  if (!match) return null
  return `${match[3]}/${match[2]}/${match[1]}`
}

function birthDateLabel(value: string | null | undefined) {
  const formatted = formatDay(value)
  return formatted ? `Nascimento ${formatted}` : 'Data de nascimento não informada'
}

function contactValue(client: ClientRecord, type: 'email' | 'phone') {
  return client.contacts.find((contact) => contact.type === type)?.value ?? ''
}

function clientInput(form: HTMLFormElement): ClientInput {
  const data = new FormData(form)
  const email = String(data.get('email') ?? '').trim()
  const phone = String(data.get('phone') ?? '').trim()
  return {
    fullName: String(data.get('fullName') ?? ''),
    clientType: String(data.get('clientType') ?? 'rotating') as ClientType,
    birthDate: String(data.get('birthDate') ?? '') || null,
    documentNumber: String(data.get('documentNumber') ?? '') || null,
    contacts: [
      ...(email ? [{ type: 'email' as const, value: email, preferred: true }] : []),
      ...(phone ? [{ type: 'phone' as const, value: phone, preferred: true }] : []),
    ],
  }
}

type ClientTypeFilter = 'all' | ClientType

const clientTypeLabels: Record<ClientType, string> = {
  fixed: 'Fixo',
  rotating: 'Rotativo',
}

const clientTypeDescriptions: Record<ClientType, string> = {
  fixed: 'Plano ou contrato com reserva recorrente.',
  rotating: 'Agenda por disponibilidade ou créditos.',
}

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short',
})

function currency(value: number, code = 'BRL') {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code }).format(value / 100)
}

function RestrictedSection() {
  return <p className="client-profile__restricted">Sua função não permite consultar esta seção.</p>
}

export function ClientsPage() {
  const { session } = useAuth()
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [clientTypeFilter, setClientTypeFilter] = useState<ClientTypeFilter>('all')
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [editing, setEditing] = useState<ClientRecord | null>(null)
  const [profile, setProfile] = useState<ClientProfile | null>(null)
  const [profileCredits, setProfileCredits] = useState<ReplacementCreditsResponse | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const canRead = organization?.permissions.includes('clients.read') ?? false
  const canManage = organization?.permissions.includes('clients.manage') ?? false
  const canManageReplacements = organization?.permissions.includes('schedule.manage') ?? false
  const canReadClinical = organization?.permissions.includes('clinical.read') ?? false
  const canWriteClinical = organization?.permissions.includes('clinical.write') ?? false
  const [clinicalFormOpen, setClinicalFormOpen] = useState(false)
  const [clinicalType, setClinicalType] = useState('evolucao')
  const [clinicalContent, setClinicalContent] = useState('')
  const [savingClinical, setSavingClinical] = useState(false)
  const canManageFinance = organization?.permissions.includes('finance.manage') ?? false
  const canManageContracts = canManage || canManageFinance

  const [contractFormOpen, setContractFormOpen] = useState(false)
  const [availablePlans, setAvailablePlans] = useState<PlanRecord[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [newPlanName, setNewPlanName] = useState('')
  const [contractStartsOn, setContractStartsOn] = useState('')
  const [contractEndsOn, setContractEndsOn] = useState('')
  const [contractPrice, setContractPrice] = useState('')
  const [savingContract, setSavingContract] = useState(false)

  async function openNewContractForm() {
    if (!session?.organizationId) return
    setError(null)
    setContractStartsOn(new Date().toISOString().slice(0, 10))
    setContractEndsOn('')
    try {
      const plans = await listPlans(session.organizationId)
      setAvailablePlans(plans)
      if (plans.length > 0) {
        setSelectedPlanId(plans[0].id)
        setContractPrice((plans[0].priceCents / 100).toFixed(2))
      } else {
        setSelectedPlanId('__new__')
        setContractPrice('250.00')
      }
      setContractFormOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os planos da clínica.')
    }
  }

  function handlePlanChange(planId: string) {
    setSelectedPlanId(planId)
    if (planId === '__new__') {
      setContractPrice('250.00')
    } else {
      const found = availablePlans.find((p) => p.id === planId)
      if (found) {
        setContractPrice((found.priceCents / 100).toFixed(2))
      }
    }
  }

  async function handleSaveContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || !profile?.client.id) return
    setSavingContract(true)
    setError(null)
    try {
      let planId = selectedPlanId
      const priceCents = Math.round(Number(contractPrice) * 100)
      if (planId === '__new__') {
        if (!newPlanName.trim()) {
          throw new Error('Informe o nome do novo plano.')
        }
        const createdPlan = await createPlan(session.organizationId, {
          name: newPlanName.trim(),
          priceCents,
        })
        planId = createdPlan.id
        setAvailablePlans((prev) => [...prev, createdPlan])
      }
      await createClientContract(session.organizationId, profile.client.id, {
        planId,
        startsOn: contractStartsOn,
        endsOn: contractEndsOn || null,
        agreedPriceCents: priceCents,
        status: 'active',
      })
      setContractFormOpen(false)
      setNewPlanName('')
      setProfile(await getClientProfile(session.organizationId, profile.client.id))
      await load()
      setMessage('Contrato do cliente vinculado com sucesso.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar o contrato.')
    } finally {
      setSavingContract(false)
    }
  }

  async function handleCancelContract(contractId: string) {
    if (!session?.organizationId || !profile?.client.id) return
    if (!window.confirm('Tem certeza de que deseja cancelar este contrato?')) return
    setSavingContract(true)
    setError(null)
    try {
      await updateClientContract(session.organizationId, profile.client.id, contractId, {
        status: 'cancelled',
      })
      setProfile(await getClientProfile(session.organizationId, profile.client.id))
      await load()
      setMessage('Contrato cancelado com sucesso.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível cancelar o contrato.')
    } finally {
      setSavingContract(false)
    }
  }

  async function handleEndContract(contractId: string) {
    if (!session?.organizationId || !profile?.client.id) return
    if (!window.confirm('Deseja encerrar este contrato a partir de hoje?')) return
    setSavingContract(true)
    setError(null)
    try {
      await updateClientContract(session.organizationId, profile.client.id, contractId, {
        status: 'ended',
        endsOn: new Date().toISOString().slice(0, 10),
      })
      setProfile(await getClientProfile(session.organizationId, profile.client.id))
      await load()
      setMessage('Contrato encerrado com sucesso.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível encerrar o contrato.')
    } finally {
      setSavingContract(false)
    }
  }

  async function saveClinicalRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || !profile?.client.id) return
    setSavingClinical(true)
    setError(null)
    try {
      const created = await createClientClinicalRecord(session.organizationId, profile.client.id, {
        recordType: clinicalType,
        content: clinicalContent,
      })
      setProfile((prev) => prev ? {
        ...prev,
        clinicalRecords: [created, ...(prev.clinicalRecords ?? [])],
      } : prev)
      setClinicalContent('')
      setClinicalFormOpen(false)
      setMessage('Evolução clínica registrada e assinada no prontuário com o registro do profissional.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível registrar no prontuário.')
    } finally {
      setSavingClinical(false)
    }
  }

  async function load() {
    if (!session?.organizationId || !canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await listClients(session.organizationId, {
        clientType: clientTypeFilter === 'all' ? undefined : clientTypeFilter,
        search,
        page,
      })
      setClients(result.items)
      setTotal(result.pagination.total)
      setTotalPages(result.pagination.totalPages)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar os clientes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setComposerOpen(false)
    setEditing(null)
    setMessage(null)
    void load()
  }, [session?.organizationId, canRead, clientTypeFilter, search, page])

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPage(1)
    setSearch(searchDraft.trim())
  }

  async function openProfile(client: ClientRecord) {
    if (!session?.organizationId) return
    setProfileLoading(true)
    setError(null)
    try {
      const [nextProfile, credits] = await Promise.all([
        getClientProfile(session.organizationId, client.id),
        listReplacementCredits(session.organizationId, client.id),
      ])
      setProfile(nextProfile)
      setProfileCredits(credits)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar o perfil.')
    } finally {
      setProfileLoading(false)
    }
  }

  async function issueCredit(sourceParticipantId: string) {
    if (!session?.organizationId || !profile) return
    setSaving(true)
    setError(null)
    try {
      await issueReplacementCredit(session.organizationId, profile.client.id, sourceParticipantId)
      setProfileCredits(await listReplacementCredits(session.organizationId, profile.client.id))
      setMessage('Crédito de reposição emitido com sucesso.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível emitir a reposição.')
    } finally {
      setSaving(false)
    }
  }

  async function cancelCredit(creditId: string) {
    if (!session?.organizationId || !profile) return
    setSaving(true)
    setError(null)
    try {
      await cancelReplacementCredit(session.organizationId, profile.client.id, creditId)
      setProfileCredits(await listReplacementCredits(session.organizationId, profile.client.id))
      setMessage('Crédito de reposição cancelado.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível cancelar a reposição.')
    } finally {
      setSaving(false)
    }
  }

  function openNewClient() {
    setEditing(null)
    setError(null)
    setComposerOpen(true)
  }

  function openEditClient(client: ClientRecord) {
    setEditing(client)
    setError(null)
    setComposerOpen(true)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    setSaving(true)
    setError(null)
    try {
      const input = clientInput(event.currentTarget)
      if (editing) {
        await updateClient(session.organizationId, editing.id, input)
        setMessage('Cadastro atualizado com sucesso.')
      } else {
        await createClient(session.organizationId, input)
        setMessage('Cliente cadastrado com sucesso.')
      }
      setComposerOpen(false)
      setEditing(null)
      await load()
    } catch (requestError) {
      setError(requestError instanceof ApiError
        ? requestError.message
        : 'Não foi possível salvar o cadastro.')
    } finally {
      setSaving(false)
    }
  }

  async function archive(client: ClientRecord) {
    if (!session?.organizationId
      || !window.confirm(`Arquivar o cadastro de ${client.fullName}?`)) return
    setError(null)
    try {
      await archiveClient(session.organizationId, client.id)
      setMessage('Cliente arquivado. O histórico foi preservado.')
      await load()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível arquivar o cliente.')
    }
  }

  return (
    <section className="clients-page" aria-labelledby="clients-title">
      <header className="clients-page__header">
        <div>
          <span>CRM · Cadastros ativos</span>
          <h1 id="clients-title">Clientes</h1>
          <p>Dados de contato seguros e isolados em {organization?.name}.</p>
        </div>
        {canManage && <Button type="button" onClick={openNewClient}>Novo cliente</Button>}
      </header>

      {message && <p className="clients-page__message" role="status">{message}</p>}
      {error && <ErrorState compact title="Não foi possível concluir" description={error} />}

      {composerOpen && canManage && (
        <Card title={editing ? 'Editar cliente' : 'Novo cliente'} description="Nome é obrigatório. Documento e contatos não podem se repetir na clínica.">
          <form key={editing?.id ?? 'new'} className="client-form" onSubmit={save}>
            <label className="client-form__wide">Nome completo
              <input name="fullName" required minLength={2} maxLength={120} autoComplete="name" defaultValue={editing?.fullName} />
            </label>
            <fieldset className="client-form__type client-form__wide">
              <legend>Tipo de cliente</legend>
              {(['fixed', 'rotating'] as const).map((clientType) => (
                <label key={clientType}>
                  <input
                    name="clientType"
                    type="radio"
                    value={clientType}
                    defaultChecked={(editing?.clientType ?? 'rotating') === clientType}
                  />
                  <span><strong>{clientTypeLabels[clientType]}</strong><small>{clientTypeDescriptions[clientType]}</small></span>
                </label>
              ))}
            </fieldset>
            <label>Data de nascimento
              <input name="birthDate" type="date" min="1900-01-01" max={new Date().toISOString().slice(0, 10)} defaultValue={editing?.birthDate ?? ''} />
            </label>
            <label>Documento
              <input name="documentNumber" maxLength={40} autoComplete="off" defaultValue={editing?.documentNumber ?? ''} />
            </label>
            <label>E-mail
              <input name="email" type="email" maxLength={160} autoComplete="email" defaultValue={editing ? contactValue(editing, 'email') : ''} />
            </label>
            <label>Telefone com DDD
              <input name="phone" type="tel" maxLength={24} autoComplete="tel" defaultValue={editing ? contactValue(editing, 'phone') : ''} />
            </label>
            <div className="client-form__actions client-form__wide">
              <Button type="submit" loading={saving}>{editing ? 'Salvar alterações' : 'Cadastrar cliente'}</Button>
              <Button type="button" variant="secondary" disabled={saving} onClick={() => setComposerOpen(false)}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {profileLoading && <LoadingState title="Carregando perfil do cliente…" />}
      {profile && !profileLoading && (
        <Card
          title={`Perfil de ${profile.client.fullName}`}
          description="Visão integrada conforme as permissões da sua função."
          footer={<Button type="button" variant="secondary" onClick={() => { setProfile(null); setProfileCredits(null) }}>Fechar perfil</Button>}
        >
          <div className="client-profile">
            <section>
              <h3>Cadastro</h3>
              <p>{birthDateLabel(profile.client.birthDate)}</p>
              <p>{contactValue(profile.client, 'phone') || 'Telefone não informado'}</p>
              <p>{contactValue(profile.client, 'email') || 'E-mail não informado'}</p>
            </section>
            <section>
              <h3>Agenda recente</h3>
              {!profile.access.schedule ? <RestrictedSection /> : profile.schedule?.length ? (
                <ul>{profile.schedule.map((appointment) => (
                  <li key={appointment.id}>
                    <strong>{appointment.serviceName}</strong>
                    <span>
                      {dateTimeFormatter.format(new Date(appointment.startsAt))} · {appointment.professionalName}
                      {appointment.professionalRegistrationNumber && (
                        <span className="client-profile__council-badge"> · CREFITO/Reg.: {appointment.professionalRegistrationNumber}</span>
                      )}
                    </span>
                    <small>{appointment.unitName} · {appointment.participantStatus}</small>
                    {canManageReplacements
                      && (appointment.participantStatus === 'absent' || appointment.participantStatus === 'cancelled')
                      && !profileCredits?.credits.some(({ source }) => source.participantId === appointment.participantId)
                      && <Button type="button" variant="secondary" disabled={saving} onClick={() => void issueCredit(appointment.participantId)}>Emitir reposição</Button>}
                  </li>
                ))}</ul>
              ) : <p>Nenhum atendimento encontrado.</p>}
            </section>
            <section className="client-profile__contracts" aria-labelledby="contracts-heading">
              <div className="client-profile__section-header">
                <h3 id="contracts-heading">Plano e Contratos</h3>
                {profile.access.plan && canManageContracts && !contractFormOpen && (
                  <Button type="button" variant="secondary" onClick={() => void openNewContractForm()}>
                    Novo contrato
                  </Button>
                )}
              </div>

              {!profile.access.plan ? (
                <RestrictedSection />
              ) : (
                <>
                  {canManageContracts && contractFormOpen && (
                    <form className="contract-form" onSubmit={handleSaveContract}>
                      <h4>Novo contrato para o cliente</h4>
                      <label>
                        Plano
                        <select
                          required
                          value={selectedPlanId}
                          onChange={(e) => handlePlanChange(e.target.value)}
                        >
                          {availablePlans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.name} — {currency(plan.priceCents, plan.currency)}/mês
                            </option>
                          ))}
                          <option value="__new__">+ Criar novo plano…</option>
                        </select>
                      </label>
                      {selectedPlanId === '__new__' && (
                        <label>
                          Nome do novo plano
                          <input
                            required
                            placeholder="Ex: Pilates 2x/semana"
                            value={newPlanName}
                            onChange={(e) => setNewPlanName(e.target.value)}
                          />
                        </label>
                      )}
                      <label>
                        Data de início
                        <input
                          name="startsOn"
                          type="date"
                          required
                          value={contractStartsOn}
                          onChange={(e) => setContractStartsOn(e.target.value)}
                        />
                      </label>
                      <label>
                        Data de término (opcional)
                        <input
                          name="endsOn"
                          type="date"
                          min={contractStartsOn || undefined}
                          value={contractEndsOn}
                          onChange={(e) => setContractEndsOn(e.target.value)}
                        />
                      </label>
                      <label>
                        Valor mensal acordado (R$)
                        <input
                          name="agreedPrice"
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={contractPrice}
                          onChange={(e) => setContractPrice(e.target.value)}
                        />
                      </label>
                      <div className="contract-form__actions">
                        <Button type="submit" disabled={savingContract}>
                          {savingContract ? 'Salvando contrato…' : 'Vincular contrato'}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={savingContract}
                          onClick={() => setContractFormOpen(false)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </form>
                  )}

                  {profile.plan?.length ? (
                    <ul className="client-profile__contract-list">
                      {profile.plan.map((contract) => (
                        <li key={contract.id} className="client-contract-card">
                          <div className="client-contract-card__info">
                            <strong>{contract.name}</strong>
                            <span>
                              {currency(contract.agreedPriceCents, contract.currency)} ·{' '}
                              <span className={`contract-status-badge contract-status-badge--${contract.status}`}>
                                {contractStatusLabels[contract.status] ?? contract.status}
                              </span>
                            </span>
                            <small>
                              Início: {formatDay(contract.startsOn) ?? 'não informado'}
                              {contract.endsOn
                                ? ` · Término: ${formatDay(contract.endsOn) ?? 'não informado'}`
                                : ' · Vigência indeterminada'}
                            </small>
                          </div>
                          {canManageContracts && (contract.status === 'active' || contract.status === 'draft') && (
                            <div className="client-contract-card__actions">
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={savingContract}
                                onClick={() => void handleCancelContract(contract.id)}
                              >
                                Cancelar
                              </Button>
                              {contract.status === 'active' && (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  disabled={savingContract}
                                  onClick={() => void handleEndContract(contract.id)}
                                >
                                  Encerrar
                                </Button>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Nenhum plano ou contrato cadastrado para este cliente.</p>
                  )}
                </>
              )}
            </section>
            <section>
              <h3>Financeiro</h3>
              {!profile.access.finance ? <RestrictedSection /> : profile.finance ? (
                <>
                  <p><strong>Saldo em aberto: {currency(profile.finance.openBalanceCents)}</strong></p>
                  {profile.finance.receivables.length ? <ul>{profile.finance.receivables.map((item) => (
                    <li key={item.id}>
                      <strong>{currency(item.balanceCents, item.currency)} em aberto</strong>
                      <span>Vencimento {formatDay(item.dueOn) ?? 'não informado'} · {item.status}</span>
                    </li>
                  ))}</ul> : <p>Nenhum lançamento encontrado.</p>}
                </>
              ) : null}
            </section>
            <section>
              <h3>Reposições</h3>
              {profileCredits ? <>
                <p><strong>{profileCredits.balance} {profileCredits.balance === 1 ? 'crédito disponível' : 'créditos disponíveis'}</strong></p>
                {profileCredits.credits.length ? <ul>{profileCredits.credits.map((credit) => (
                  <li key={credit.id}>
                    <strong>{credit.status === 'available' ? 'Disponível' : credit.status === 'consumed' ? 'Utilizado' : credit.status === 'expired' ? 'Vencido' : 'Cancelado'}</strong>
                    <span>Validade: {new Date(credit.expiresOn).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</span>
                    {credit.status === 'available' && canManageReplacements && <Button type="button" variant="secondary" disabled={saving} onClick={() => void cancelCredit(credit.id)}>Cancelar crédito</Button>}
                  </li>
                ))}</ul> : <p>Nenhuma reposição emitida.</p>}
              </> : <p>Carregando reposições…</p>}
            </section>
            <section>
              <h3>Histórico</h3>
              {!profile.access.history ? <RestrictedSection /> : profile.history?.length ? (
                <ul>{profile.history.map((event) => (
                  <li key={event.id}>
                    <strong>{event.action}</strong>
                    <span>{dateTimeFormatter.format(new Date(event.occurredAt))}</span>
                  </li>
                ))}</ul>
              ) : <p>Nenhum evento registrado.</p>}
            </section>
            <section className="client-profile__prontuario" aria-labelledby="prontuario-heading">
              <div className="client-profile__section-header">
                <h3 id="prontuario-heading">Prontuário e Evoluções Clínicas</h3>
                {(profile.access.clinical || canReadClinical) && canWriteClinical && !clinicalFormOpen && (
                  <Button type="button" variant="secondary" onClick={() => setClinicalFormOpen(true)}>
                    Nova evolução clínica
                  </Button>
                )}
              </div>

              {!profile.access.clinical && !canReadClinical ? (
                <RestrictedSection />
              ) : (
                <>
                  {canWriteClinical && clinicalFormOpen && (
                    <form className="clinical-record-form" onSubmit={saveClinicalRecord}>
                      <h4>Nova anotação no prontuário</h4>
                      <label>
                        Tipo de atendimento / registro
                        <select
                          value={clinicalType}
                          onChange={(event) => setClinicalType(event.target.value)}
                        >
                          <option value="evolucao">Evolução Fisioterapêutica / Clínica</option>
                          <option value="anamnese">Anamnese / Avaliação Inicial</option>
                          <option value="consulta">Consulta / Atendimento</option>
                          <option value="observacao">Observação Clínica</option>
                        </select>
                      </label>
                      <label>
                        Evolução clínica e conduta
                        <textarea
                          required
                          rows={4}
                          placeholder="Descreva as queixas, evolução do quadro, condutas realizadas e orientações clínicas..."
                          value={clinicalContent}
                          onChange={(event) => setClinicalContent(event.target.value)}
                        />
                      </label>
                      <div className="clinical-record-form__actions">
                        <Button type="submit" disabled={savingClinical}>
                          {savingClinical ? 'Assinando e registrando…' : 'Registrar no prontuário'}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={savingClinical}
                          onClick={() => { setClinicalFormOpen(false); setClinicalContent('') }}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </form>
                  )}

                  {profile.clinicalRecords?.length ? (
                    <ul className="clinical-record-list">
                      {profile.clinicalRecords.map((record) => (
                        <li key={record.id} className="clinical-record-item">
                          <header className="clinical-record-item__header">
                            <div>
                              <strong>{recordTypeLabels[record.recordType] || record.recordType}</strong>
                              <span>{dateTimeFormatter.format(new Date(record.occurredAt))}</span>
                            </div>
                            <span className="clinical-record-item__council">
                              {record.authorProfessional.registrationNumber
                                ? `Registro: ${record.authorProfessional.registrationNumber}`
                                : 'Sem registro profissional'}
                            </span>
                          </header>
                          <p className="clinical-record-item__content">{record.content}</p>
                          <footer className="clinical-record-item__footer">
                            <small>
                              Profissional responsável: <strong>{record.authorProfessional.displayName}</strong>
                              {record.authorProfessional.registrationNumber && ` (CREFITO/Reg.: ${record.authorProfessional.registrationNumber})`}
                              {record.signedAt && ` · Assinado digitalmente`}
                            </small>
                          </footer>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Nenhuma evolução registrada no prontuário deste paciente.</p>
                  )}
                </>
              )}
            </section>
          </div>
        </Card>
      )}

      <Card title="Cadastros" description={`${total} cliente${total === 1 ? '' : 's'} encontrado${total === 1 ? '' : 's'}. A exclusão preserva o histórico.`}>
        {canRead && (
          <div className="client-toolbar">
            <form className="client-search" role="search" onSubmit={applySearch}>
              <label htmlFor="client-search">Buscar por nome ou contato</label>
              <div>
                <input id="client-search" type="search" maxLength={100} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
                <Button type="submit">Buscar</Button>
              </div>
            </form>
            <div className="client-filters" aria-label="Filtrar clientes por tipo">
              {([
                ['all', 'Todos'],
                ['fixed', 'Fixos'],
                ['rotating', 'Rotativos'],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={clientTypeFilter === value ? 'primary' : 'secondary'}
                  aria-pressed={clientTypeFilter === value}
                  onClick={() => { setPage(1); setClientTypeFilter(value) }}
                >{label}</Button>
              ))}
            </div>
          </div>
        )}
        {loading ? <LoadingState title="Carregando clientes…" /> : !canRead ? (
          <EmptyState title="Acesso restrito" description="Sua função não permite consultar os clientes desta organização." />
        ) : clients.length === 0 ? (
          <EmptyState
            title={search ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
            description={search
              ? 'Nenhum cadastro corresponde a essa parte do nome ou do contato.'
              : 'Cadastre a primeira pessoa para começar a operação.'}
            action={!search && canManage ? <Button type="button" onClick={openNewClient}>Cadastrar cliente</Button> : undefined}
          />
        ) : (
          <ul className="client-list" aria-label="Clientes ativos">
            {clients.map((client) => (
              <li key={client.id}>
                <span className="client-list__identity" aria-hidden="true">{client.fullName.slice(0, 2).toUpperCase()}</span>
                <span className="client-list__details">
                  <span className="client-list__name">
                    <strong>{client.fullName}</strong>
                    <StatusBadge tone={client.clientType === 'fixed' ? 'success' : 'neutral'}>
                      {clientTypeLabels[client.clientType]}
                    </StatusBadge>
                  </span>
                  <small>{contactValue(client, 'phone') || contactValue(client, 'email') || 'Sem contato informado'}</small>
                  <small>{clientTypeDescriptions[client.clientType]}</small>
                </span>
                <span className="client-list__actions">
                  <Button type="button" variant="secondary" onClick={() => void openProfile(client)}>Ver perfil</Button>
                  <Button type="button" variant="secondary" onClick={() => void openProfile(client)}>Prontuário</Button>
                  {canManage && <>
                    <Button type="button" variant="secondary" onClick={() => openEditClient(client)}>Editar</Button>
                    <Button type="button" variant="secondary" onClick={() => void archive(client)}>Arquivar</Button>
                  </>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canRead && totalPages > 1 && (
          <nav className="client-pagination" aria-label="Paginação de clientes">
            <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</Button>
            <span>Página {page} de {totalPages}</span>
            <Button type="button" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</Button>
          </nav>
        )}
      </Card>
    </section>
  )
}
