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
  listProfessionals,
  listReplacementCredits,
  scheduleContractSessions,
  updateClient,
  updateClientContract,
  type ClientInput,
  type ClientProfile,
  type ClientRecord,
  type ClientType,
  type PlanRecord,
  type ProfessionalOption,
  type ReplacementCreditsResponse,
} from '@/features/clients'
import { listResources } from '@/features/resources'
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

const saleWeekdays = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']

function currency(value: number, code = 'BRL') {
  const normalized = String(code || 'BRL').trim().toUpperCase()
  const safe = /^[A-Z]{3}$/u.test(normalized) ? normalized : 'BRL'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: safe }).format((Number(value) || 0) / 100)
}

function asPlans(value: unknown): PlanRecord[] {
  return Array.isArray(value) ? value as PlanRecord[] : []
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
  const [plansOpen, setPlansOpen] = useState(false)
  const [newPlanKind, setNewPlanKind] = useState<'monthly' | 'package'>('monthly')
  const [catalogKind, setCatalogKind] = useState<'monthly' | 'package'>('monthly')
  const [catalogServices, setCatalogServices] = useState<Array<{ id: string; name: string }>>([])
  const [catalogUnits, setCatalogUnits] = useState<Array<{ id: string; name: string }>>([])
  const [saleProfessionals, setSaleProfessionals] = useState<ProfessionalOption[]>([])
  const [sessionCount, setSessionCount] = useState('8')
  const [saleProfessionalId, setSaleProfessionalId] = useState('')
  const [saleServiceId, setSaleServiceId] = useState('')
  const [saleUnitId, setSaleUnitId] = useState('')
  const [saleSlots, setSaleSlots] = useState<Array<{ weekday: string; localTime: string }>>([{ weekday: '1', localTime: '14:00' }])
  const [generateSessions, setGenerateSessions] = useState(true)
  const [savingPlan, setSavingPlan] = useState(false)

  async function openNewContractForm() {
    if (!session?.organizationId) return
    setError(null)
    setContractStartsOn(new Date().toISOString().slice(0, 10))
    setContractEndsOn('')
    try {
      const plans = asPlans(await listPlans(session.organizationId))
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

  async function loadSaleCatalog() {
    if (!session?.organizationId) return
    const [professionals, catalog] = await Promise.all([
      listProfessionals(session.organizationId).catch(() => []),
      listResources(session.organizationId, 'active').catch(() => null),
    ])
    const nextProfessionals = Array.isArray(professionals) ? professionals.filter((item) => item.active !== false) : []
    const nextServices = catalog?.services?.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name })) ?? []
    const nextUnits = catalog?.units?.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name })) ?? []
    setSaleProfessionals(nextProfessionals)
    setCatalogServices(nextServices)
    setCatalogUnits(nextUnits)
    setSaleProfessionalId((current) => current || nextProfessionals[0]?.id || '')
    setSaleServiceId((current) => current || nextServices[0]?.id || '')
    setSaleUnitId((current) => current || nextUnits[0]?.id || '')
  }

  function handlePlanChange(planId: string) {
    setSelectedPlanId(planId)
    if (planId === '__new__') {
      setContractPrice('250.00')
      if (newPlanKind === 'package') void loadSaleCatalog()
      return
    }
    const found = availablePlans.find((p) => p.id === planId)
    if (found) {
      setContractPrice((found.priceCents / 100).toFixed(2))
      if (found.kind === 'package') {
        setSessionCount(String(found.sessionCount ?? 8))
        if (found.serviceId) setSaleServiceId(found.serviceId)
        void loadSaleCatalog()
      }
    }
  }

  async function openPlansCatalog() {
    if (!session?.organizationId) return
    setPlansOpen(true)
    setError(null)
    try {
      setAvailablePlans(asPlans(await listPlans(session.organizationId)))
      await loadSaleCatalog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os planos da clínica.')
    }
  }

  async function saveClinicPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    const form = event.currentTarget
    const data = new FormData(form)
    const name = String(data.get('name') ?? '').trim()
    const priceCents = Math.round(Number(data.get('price') ?? 0) * 100)
    setSavingPlan(true)
    setError(null)
    try {
      if (!name) throw new Error('Informe o nome do plano.')
      if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('Informe um valor válido para o plano.')
      const created = await createPlan(session.organizationId, {
        name,
        priceCents,
        kind: catalogKind,
        sessionCount: catalogKind === 'package' ? Number(data.get('sessionCount')) : undefined,
        serviceId: catalogKind === 'package' ? String(data.get('serviceId') || '') || null : null,
      })
      setAvailablePlans((current) => [...current.filter((plan) => plan.id !== created.id), created].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR')))
      setMessage('Plano cadastrado. Ele já pode ser escolhido na venda do contrato.')
      form.reset()
      setCatalogKind('monthly')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar o plano.')
    } finally {
      setSavingPlan(false)
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
      const selectedPlan = availablePlans.find((plan) => plan.id === planId)
      const packageSale = planId === '__new__' ? newPlanKind === 'package' : selectedPlan?.kind === 'package'
      if (packageSale) {
        if (!Number.isInteger(Number(sessionCount)) || Number(sessionCount) < 1) {
          throw new Error('Informe a quantidade de sessões do pacote.')
        }
        if (!saleProfessionalId) throw new Error('Escolha o profissional responsável.')
        if (!saleSlots.length) throw new Error('Informe ao menos um horário semanal.')
        if (generateSessions && canManageReplacements && !saleUnitId) throw new Error('Escolha a unidade das sessões.')
        if (generateSessions && canManageReplacements && !saleServiceId && !selectedPlan?.serviceId) {
          throw new Error('Escolha o serviço das sessões.')
        }
      }
      if (planId === '__new__') {
        if (!newPlanName.trim()) {
          throw new Error('Informe o nome do novo plano.')
        }
        const createdPlan = await createPlan(session.organizationId, {
          name: newPlanName.trim(),
          priceCents,
          kind: newPlanKind,
          sessionCount: newPlanKind === 'package' ? Number(sessionCount) : undefined,
          serviceId: newPlanKind === 'package' ? saleServiceId || null : null,
        })
        planId = createdPlan.id
        setAvailablePlans((prev) => [...prev, createdPlan])
      }
      const saved = await createClientContract(session.organizationId, profile.client.id, {
        planId,
        startsOn: contractStartsOn,
        endsOn: contractEndsOn || null,
        agreedPriceCents: priceCents,
        status: 'active',
        ...(packageSale ? {
          sessionCount: Number(sessionCount),
          professionalId: saleProfessionalId,
          scheduleSlots: saleSlots.map((slot) => ({ weekday: Number(slot.weekday), localTime: slot.localTime })),
        } : {}),
      })
      let sessionMessage = 'Contrato do cliente vinculado com sucesso.'
      if (packageSale && generateSessions && canManageReplacements) {
        try {
          const scheduled = await scheduleContractSessions(session.organizationId, profile.client.id, saved.id, {
            unitId: saleUnitId,
            serviceId: saleServiceId || selectedPlan?.serviceId || undefined,
          })
          sessionMessage = scheduled.created
            ? `Contrato salvo. ${scheduled.count} sessões foram geradas na agenda.`
            : 'Contrato salvo. As sessões deste pacote já estavam na agenda.'
        } catch (scheduleError) {
          setContractFormOpen(false)
          setNewPlanName('')
          setProfile(await getClientProfile(session.organizationId, profile.client.id))
          await load()
          throw new Error(`Contrato salvo. As sessões não foram geradas: ${scheduleError instanceof Error ? scheduleError.message : 'verifique o expediente do profissional.'}`)
        }
      }
      setContractFormOpen(false)
      setNewPlanName('')
      setProfile(await getClientProfile(session.organizationId, profile.client.id))
      await load()
      setMessage(sessionMessage)
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

  async function generateSavedSessions(contractId: string) {
    if (!session?.organizationId || !profile?.client.id) return
    setSavingContract(true)
    setError(null)
    try {
      const catalog = await listResources(session.organizationId, 'active')
      const unitId = catalog.units.find((unit) => unit.active)?.id
      if (!unitId) throw new Error('Cadastre uma unidade antes de gerar as sessões.')
      const scheduled = await scheduleContractSessions(session.organizationId, profile.client.id, contractId, { unitId })
      setProfile(await getClientProfile(session.organizationId, profile.client.id))
      setMessage(scheduled.created
        ? `${scheduled.count} sessões geradas na agenda.`
        : 'As sessões deste pacote já estavam na agenda.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gerar as sessões.')
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
        <div>
          {canManageContracts && <Button type="button" variant="secondary" onClick={() => void openPlansCatalog()}>Planos da clínica</Button>}
          {canManage && <Button type="button" onClick={openNewClient}>Novo cliente</Button>}
        </div>
      </header>

      {message && <p className="clients-page__message" role="status">{message}</p>}
      {error && <ErrorState compact title="Não foi possível concluir" description={error} />}

      {plansOpen && canManageContracts && (
        <Card title="Planos da clínica" description="Os planos cadastrados aqui aparecem na venda do contrato de cada paciente.">
          {availablePlans.length === 0 ? <p>Nenhum plano ativo cadastrado.</p> : (
            <ul className="client-profile__contract-list">
              {availablePlans.map((plan) => (
                <li key={plan.id}>
                  <strong>{plan.name}</strong>
                  <span>{plan.kind === 'package' ? `Pacote · ${plan.sessionCount ?? 0} sessões` : 'Mensalidade'} · {currency(plan.priceCents, plan.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          <form className="contract-form" onSubmit={saveClinicPlan}>
            <label>Nome do plano<input name="name" required minLength={2} maxLength={120} placeholder="Ex.: Pilates 2x por semana" /></label>
            <label>Tipo
              <select value={catalogKind} onChange={(event) => setCatalogKind(event.target.value as 'monthly' | 'package')}>
                <option value="monthly">Mensalidade</option>
                <option value="package">Pacote de sessões</option>
              </select>
            </label>
            <label>Valor (R$)<input name="price" type="number" required min={0} step="0.01" defaultValue="250.00" /></label>
            {catalogKind === 'package' && <>
              <label>Sessões<input name="sessionCount" type="number" required min={1} max={500} defaultValue={8} /></label>
              <label>Serviço do pacote
                <select name="serviceId" defaultValue="">
                  <option value="">Definir na venda</option>
                  {catalogServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                </select>
              </label>
            </>}
            <div className="contract-form__actions">
              <Button type="submit" disabled={savingPlan}>{savingPlan ? 'Salvando plano…' : 'Cadastrar plano'}</Button>
              <Button type="button" variant="secondary" onClick={() => setPlansOpen(false)}>Fechar</Button>
            </div>
          </form>
        </Card>
      )}

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
                              {plan.name} — {currency(plan.priceCents, plan.currency)}{plan.kind === 'package' ? '' : '/mês'}
                            </option>
                          ))}
                          <option value="__new__">+ Criar novo plano…</option>
                        </select>
                      </label>
                      {selectedPlanId === '__new__' && (
                        <>
                          <label>
                            Nome do novo plano
                            <input
                              required
                              placeholder="Ex: Pilates 2x/semana"
                              value={newPlanName}
                              onChange={(e) => setNewPlanName(e.target.value)}
                            />
                          </label>
                          <label>
                            Tipo do plano
                            <select value={newPlanKind} onChange={(event) => {
                              const kind = event.target.value as 'monthly' | 'package'
                              setNewPlanKind(kind)
                              if (kind === 'package') void loadSaleCatalog()
                            }}>
                              <option value="monthly">Mensalidade</option>
                              <option value="package">Pacote de sessões</option>
                            </select>
                          </label>
                        </>
                      )}
                      {availablePlans.length === 0 && selectedPlanId !== '__new__' && (
                        <p>Nenhum plano ativo. Cadastre um em Planos da clínica para concluir a venda.</p>
                      )}
                      {(selectedPlanId === '__new__' ? newPlanKind === 'package' : availablePlans.find((plan) => plan.id === selectedPlanId)?.kind === 'package') && (
                        <>
                          <label>Quantidade de sessões
                            <input type="number" required min={1} max={500} value={sessionCount} onChange={(event) => setSessionCount(event.target.value)} />
                          </label>
                          <label>Profissional responsável
                            <select required value={saleProfessionalId} onChange={(event) => setSaleProfessionalId(event.target.value)}>
                              <option value="" disabled>Selecione</option>
                              {saleProfessionals.map((professional) => <option key={professional.id} value={professional.id}>{professional.displayName}</option>)}
                            </select>
                          </label>
                          <label>Serviço das sessões
                            <select value={saleServiceId} onChange={(event) => setSaleServiceId(event.target.value)}>
                              <option value="">Usar o serviço do plano</option>
                              {catalogServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                            </select>
                          </label>
                          {canManageReplacements && <label>Unidade
                            <select required={generateSessions} value={saleUnitId} onChange={(event) => setSaleUnitId(event.target.value)}>
                              <option value="" disabled>Selecione</option>
                              {catalogUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                            </select>
                          </label>}
                          {saleSlots.map((slot, index) => (
                            <div key={`${slot.weekday}-${index}`}>
                              <label>Dia do horário {index + 1}
                                <select value={slot.weekday} onChange={(event) => setSaleSlots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, weekday: event.target.value } : item))}>
                                  {saleWeekdays.slice(1).map((name, weekday) => <option key={name} value={weekday + 1}>{name}</option>)}
                                </select>
                              </label>
                              <label>Hora do horário {index + 1}
                                <input type="time" required value={slot.localTime} onChange={(event) => setSaleSlots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, localTime: event.target.value } : item))} />
                              </label>
                            </div>
                          ))}
                          <div className="contract-form__actions">
                            <Button type="button" variant="secondary" onClick={() => setSaleSlots((current) => [...current, { weekday: '3', localTime: '14:00' }])}>Adicionar horário</Button>
                            {saleSlots.length > 1 && <Button type="button" variant="secondary" onClick={() => setSaleSlots((current) => current.slice(0, -1))}>Remover horário</Button>}
                          </div>
                          {canManageReplacements && <label><input type="checkbox" checked={generateSessions} onChange={(event) => setGenerateSessions(event.target.checked)} /> Gerar as sessões na agenda</label>}
                        </>
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
                        {(selectedPlanId === '__new__' ? newPlanKind === 'package' : availablePlans.find((plan) => plan.id === selectedPlanId)?.kind === 'package') ? 'Valor do pacote (R$)' : 'Valor mensal acordado (R$)'}
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
                            {contract.sessionCount ? <small>{contract.sessionCount} sessões{contract.professionalName ? ` · ${contract.professionalName}` : ''}</small> : null}
                            {contract.scheduleSlots?.length ? <small>{contract.scheduleSlots.map((slot) => `${saleWeekdays[slot.weekday]} ${slot.localTime}`).join(' · ')}</small> : null}
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
                              {contract.sessionCount && canManageReplacements && (
                                <Button type="button" variant="secondary" disabled={savingContract} onClick={() => void generateSavedSessions(contract.id)}>
                                  Gerar sessões
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
