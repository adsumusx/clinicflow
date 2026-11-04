import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, useAuth } from '@/features/auth'
import type { ClientType } from '@/features/clients'
import {
  addProspectInteraction,
  convertProspect,
  createProspect,
  getProspect,
  listProspects,
  updateProspect,
  type ProspectInput,
  type ProspectOwner,
  type ProspectRecord,
  type ProspectStage,
} from '@/features/leads'
import { Button, Card, EmptyState, ErrorState, Icon, LoadingState, StatusBadge } from '@/shared/ui'
import './LeadsPage.css'

type StageFilter = 'all' | ProspectStage
type EditableStage = Exclude<ProspectStage, 'converted'>

const stageLabels: Record<ProspectStage, string> = {
  new: 'Nova',
  contacted: 'Contatada',
  qualified: 'Qualificada',
  proposal: 'Proposta',
  lost: 'Perdida',
  converted: 'Convertida',
}

const stageOrder: ProspectStage[] = ['new', 'contacted', 'qualified', 'proposal', 'lost', 'converted']
const editableStages: EditableStage[] = ['new', 'contacted', 'qualified', 'proposal', 'lost']
const interactionLabels = {
  call: 'Ligação', email: 'E-mail', message: 'Mensagem', meeting: 'Reunião', note: 'Anotação',
  stage_change: 'Mudança de etapa', conversion: 'Conversão em cliente',
}
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function contactValue(prospect: ProspectRecord, type: 'email' | 'phone') {
  return prospect.contacts.find((contact) => contact.type === type)?.value ?? ''
}

function localDateTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function prospectInput(form: HTMLFormElement): ProspectInput {
  const data = new FormData(form)
  const email = String(data.get('email') ?? '').trim()
  const phone = String(data.get('phone') ?? '').trim()
  const nextActionValue = String(data.get('nextActionAt') ?? '')
  return {
    fullName: String(data.get('fullName') ?? ''),
    source: String(data.get('source') ?? ''),
    stage: String(data.get('stage') ?? 'new') as EditableStage,
    ownerProfessionalId: String(data.get('ownerProfessionalId') ?? '') || null,
    nextActionAt: nextActionValue ? new Date(nextActionValue).toISOString() : null,
    nextActionNote: String(data.get('nextActionNote') ?? '').trim() || null,
    contacts: [
      ...(email ? [{ type: 'email' as const, value: email, preferred: true }] : []),
      ...(phone ? [{ type: 'phone' as const, value: phone, preferred: true }] : []),
    ],
  }
}

function stageTone(stage: ProspectStage) {
  if (stage === 'converted') return 'success' as const
  if (stage === 'lost' || stage === 'proposal') return 'warning' as const
  return 'neutral' as const
}

function nextActionText(prospect: ProspectRecord) {
  if (!prospect.nextActionAt) {
    return prospect.stage === 'converted' ? 'Conversão concluída' : 'Não definida'
  }
  const when = dateTimeFormatter.format(new Date(prospect.nextActionAt))
  return prospect.nextActionNote ? `${prospect.nextActionNote} · ${when}` : when
}

type LeadScreen =
  | { type: 'board' }
  | { type: 'composer'; prospect: ProspectRecord | null }
  | { type: 'history'; prospect: ProspectRecord }
  | { type: 'interaction'; prospect: ProspectRecord; back: 'board' | 'history' }
  | { type: 'conversion'; prospect: ProspectRecord }

function backLabel(screen: LeadScreen) {
  if (screen.type === 'interaction' && screen.back === 'history') return 'Voltar para o histórico'
  return 'Voltar para o funil'
}

export function LeadsPage() {
  const { session } = useAuth()
  const [prospects, setProspects] = useState<ProspectRecord[]>([])
  const [owners, setOwners] = useState<ProspectOwner[]>([])
  const [stageCounts, setStageCounts] = useState<Partial<Record<ProspectStage, number>>>({})
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [screen, setScreen] = useState<LeadScreen>({ type: 'board' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const canRead = organization?.permissions.includes('prospects.read') ?? false
  const canManage = organization?.permissions.includes('prospects.manage') ?? false
  const canConvert = canManage && (organization?.permissions.includes('clients.manage') ?? false)

  async function load() {
    if (!session?.organizationId || !canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await listProspects(session.organizationId, {
        search,
        page,
        stage: stageFilter === 'all' ? undefined : stageFilter,
      })
      setProspects(result.items)
      setOwners(result.owners ?? [])
      setStageCounts(result.stageCounts ?? {})
      setTotal(result.pagination.total)
      setTotalPages(result.pagination.totalPages)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar as prospecções.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setScreen({ type: 'board' })
    setMessage(null)
    void load()
  }, [session?.organizationId, canRead, search, page, stageFilter])

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPage(1)
    setSearch(searchDraft.trim())
  }

  function goBack() {
    setError(null)
    if (screen.type === 'interaction' && screen.back === 'history') {
      setScreen({ type: 'history', prospect: screen.prospect })
      return
    }
    setScreen({ type: 'board' })
  }

  function openNewProspect() {
    setError(null)
    setScreen({ type: 'composer', prospect: null })
  }

  function openEditProspect(prospect: ProspectRecord) {
    setError(null)
    setScreen({ type: 'composer', prospect })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || screen.type !== 'composer') return
    const editing = screen.prospect
    setSaving(true)
    setError(null)
    try {
      const input = prospectInput(event.currentTarget)
      if (editing) {
        await updateProspect(session.organizationId, editing.id, input)
        setMessage('Prospecção atualizada com sucesso.')
      } else {
        await createProspect(session.organizationId, input)
        setMessage('Prospecção cadastrada com sucesso.')
      }
      setScreen({ type: 'board' })
      await load()
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Não foi possível salvar a prospecção.')
    } finally {
      setSaving(false)
    }
  }

  async function openHistory(prospect: ProspectRecord) {
    if (!session?.organizationId) return
    setError(null)
    try {
      setScreen({ type: 'history', prospect: await getProspect(session.organizationId, prospect.id) })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar o histórico.')
    }
  }

  async function saveInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || screen.type !== 'interaction') return
    const current = screen
    setSaving(true)
    setError(null)
    const data = new FormData(event.currentTarget)
    try {
      await addProspectInteraction(session.organizationId, current.prospect.id, {
        type: String(data.get('type') ?? 'note') as 'call' | 'email' | 'message' | 'meeting' | 'note',
        notes: String(data.get('notes') ?? ''),
      })
      const updated = await getProspect(session.organizationId, current.prospect.id)
      setMessage('Contato registrado no histórico.')
      setScreen(current.back === 'history'
        ? { type: 'history', prospect: updated }
        : { type: 'board' })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível registrar o contato.')
    } finally {
      setSaving(false)
    }
  }

  async function saveConversion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId || screen.type !== 'conversion') return
    const conversionTarget = screen.prospect
    setSaving(true)
    setError(null)
    const data = new FormData(event.currentTarget)
    try {
      const result = await convertProspect(session.organizationId, conversionTarget.id, {
        clientType: String(data.get('clientType') ?? 'rotating') as ClientType,
        birthDate: String(data.get('birthDate') ?? '') || null,
        documentNumber: String(data.get('documentNumber') ?? '') || null,
      })
      setScreen({ type: 'board' })
      setMessage(result.created
        ? 'Prospecção convertida em cliente. O histórico foi preservado.'
        : 'Esta prospecção já estava convertida; nenhum cliente foi duplicado.')
      await load()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível converter a prospecção.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="leads-page" aria-labelledby="leads-title">
      <header className="leads-page__header">
        <div>
          <span>CRM · Funil comercial</span>
          <h1 id="leads-title">Prospecções</h1>
          <p>Acompanhe contatos e próximas ações em {organization?.name}.</p>
        </div>
        {canManage && <Button type="button" onClick={openNewProspect}>Nova prospecção</Button>}
      </header>

      {message && <p className="leads-page__message" role="status">{message}</p>}
      {error && <ErrorState compact title="Não foi possível concluir" description={error} />}

      {screen.type !== 'board' && (
        <button type="button" className="lead-back" onClick={goBack}>
          <Icon name="chevron-left" />
          {backLabel(screen)}
        </button>
      )}

      {screen.type === 'board' && canRead && (
        <div className="lead-funnel" aria-label="Resumo do funil">
          {stageOrder.map((stage) => (
            <button
              key={stage}
              type="button"
              className={`lead-funnel__stage${stageFilter === stage ? ' lead-funnel__stage--active' : ''}`}
              aria-pressed={stageFilter === stage}
              onClick={() => {
                setPage(1)
                setStageFilter((current) => current === stage ? 'all' : stage)
              }}
            >
              <span>{stageLabels[stage]}</span>
              <strong>{stageCounts[stage] ?? 0}</strong>
            </button>
          ))}
        </div>
      )}

      {screen.type === 'composer' && canManage && (
        <Card title={screen.prospect ? 'Editar prospecção' : 'Nova prospecção'} description="Registre ao menos o nome e a origem. Contatos ficam disponíveis para a conversão.">
          <form key={screen.prospect?.id ?? 'new'} className="lead-form" onSubmit={save}>
            <label className="lead-form__wide">Nome completo
              <input name="fullName" required minLength={2} maxLength={120} autoComplete="name" defaultValue={screen.prospect?.fullName} />
            </label>
            <label>Origem
              <input name="source" required minLength={2} maxLength={80} placeholder="Ex.: indicação, Instagram" defaultValue={screen.prospect?.source} />
            </label>
            <label>Etapa
              <select name="stage" defaultValue={screen.prospect?.stage ?? 'new'}>
                {editableStages.map((stage) => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}
              </select>
            </label>
            <label>Responsável
              <select name="ownerProfessionalId" defaultValue={screen.prospect?.owner?.id ?? ''}>
                <option value="">Sem responsável</option>
                {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.displayName}</option>)}
              </select>
            </label>
            <label>E-mail
              <input name="email" type="email" maxLength={160} autoComplete="email" defaultValue={screen.prospect ? contactValue(screen.prospect, 'email') : ''} />
            </label>
            <label>Telefone com DDD
              <input name="phone" type="tel" maxLength={24} autoComplete="tel" defaultValue={screen.prospect ? contactValue(screen.prospect, 'phone') : ''} />
            </label>
            <label>Data da próxima ação
              <input name="nextActionAt" type="datetime-local" defaultValue={localDateTime(screen.prospect?.nextActionAt ?? null)} />
            </label>
            <label className="lead-form__wide">Próxima ação
              <input name="nextActionNote" maxLength={240} placeholder="Ex.: confirmar aula experimental" defaultValue={screen.prospect?.nextActionNote ?? ''} />
            </label>
            <div className="lead-form__actions lead-form__wide">
              <Button type="submit" loading={saving}>{screen.prospect ? 'Salvar alterações' : 'Cadastrar prospecção'}</Button>
              <Button type="button" variant="secondary" disabled={saving} onClick={goBack}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {screen.type === 'history' && (
        <Card
          title={`Histórico de ${screen.prospect.fullName}`}
          description="Interações e mudanças permanecem vinculadas à prospecção, inclusive após a conversão."
        >
          {canManage && screen.prospect.stage !== 'converted' && (
            <Button type="button" onClick={() => setScreen({ type: 'interaction', prospect: screen.prospect, back: 'history' })}>Registrar contato</Button>
          )}
          {screen.prospect.interactions.length ? (
            <ol className="lead-history">
              {screen.prospect.interactions.map((interaction) => (
                <li key={interaction.id}>
                  <strong>{interactionLabels[interaction.type]}</strong>
                  <span>{dateTimeFormatter.format(new Date(interaction.occurredAt))}</span>
                  {interaction.notes && <p>{interaction.notes}</p>}
                </li>
              ))}
            </ol>
          ) : <p>Nenhuma interação registrada.</p>}
        </Card>
      )}

      {screen.type === 'interaction' && canManage && (
        <Card title={`Registrar contato de ${screen.prospect.fullName}`} description="O registro entra no histórico desta prospecção.">
          <form className="lead-interaction-form" onSubmit={saveInteraction}>
            <label>Tipo
              <select name="type" defaultValue="call">
                <option value="call">Ligação</option>
                <option value="email">E-mail</option>
                <option value="message">Mensagem</option>
                <option value="meeting">Reunião</option>
                <option value="note">Anotação</option>
              </select>
            </label>
            <label>Resumo do contato
              <textarea name="notes" required minLength={2} maxLength={2000} rows={3} />
            </label>
            <div className="lead-form__actions">
              <Button type="submit" loading={saving}>Registrar contato</Button>
              <Button type="button" variant="secondary" disabled={saving} onClick={goBack}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {screen.type === 'conversion' && canConvert && (
        <Card title={`Converter ${screen.prospect.fullName}`} description="Será criado um cliente com o nome e os contatos desta prospecção. Repetir a operação não cria duplicidade.">
          <form className="lead-form" onSubmit={saveConversion}>
            <fieldset className="lead-form__type lead-form__wide">
              <legend>Tipo de cliente</legend>
              <label><input name="clientType" type="radio" value="fixed" /> <span><strong>Fixo</strong><small>Contrato e reserva recorrente.</small></span></label>
              <label><input name="clientType" type="radio" value="rotating" defaultChecked /> <span><strong>Rotativo</strong><small>Disponibilidade ou créditos.</small></span></label>
            </fieldset>
            <label>Data de nascimento
              <input name="birthDate" type="date" min="1900-01-01" max={new Date().toISOString().slice(0, 10)} />
            </label>
            <label>Documento
              <input name="documentNumber" maxLength={40} autoComplete="off" />
            </label>
            <div className="lead-form__actions lead-form__wide">
              <Button type="submit" loading={saving}>Confirmar conversão</Button>
              <Button type="button" variant="secondary" disabled={saving} onClick={goBack}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {screen.type === 'board' && (
      <Card title="Prospecções" description={`${total} registro${total === 1 ? '' : 's'} encontrado${total === 1 ? '' : 's'}.`}>
        {canRead && (
          <div className="lead-toolbar">
            <form className="lead-search" role="search" onSubmit={applySearch}>
              <label htmlFor="lead-search">Buscar por nome ou contato</label>
              <div>
                <input id="lead-search" type="search" maxLength={100} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
                <Button type="submit">Buscar</Button>
                {stageFilter !== 'all' && <Button type="button" variant="secondary" onClick={() => setStageFilter('all')}>Todas as etapas</Button>}
              </div>
            </form>
          </div>
        )}
        {loading ? <LoadingState title="Carregando prospecções…" /> : !canRead ? (
          <EmptyState title="Acesso restrito" description="Sua função não permite consultar as prospecções desta organização." />
        ) : prospects.length === 0 ? (
          <EmptyState
            title="Nenhuma prospecção encontrada"
            description="Cadastre uma oportunidade e defina a próxima ação."
            action={canManage ? <Button type="button" onClick={openNewProspect}>Nova prospecção</Button> : undefined}
          />
        ) : (
          <section className={`lead-board${stageFilter === 'all' ? '' : ' lead-board--filtered'}`} aria-label="Funil de prospecções">
            {(stageFilter === 'all' ? stageOrder : stageOrder.filter((stage) => stage === stageFilter)).map((stage) => {
              const column = prospects.filter((prospect) => prospect.stage === stage)
              return (
                <section
                  key={stage}
                  id={`lead-column-${stage}`}
                  className={`lead-column${stageFilter === stage ? ' lead-column--active' : ''}`}
                  aria-labelledby={`lead-column-title-${stage}`}
                >
                  <header>
                    <h3 id={`lead-column-title-${stage}`}>{stageLabels[stage]}</h3>
                    <strong>{stageCounts[stage] ?? column.length}</strong>
                  </header>
                  {column.length === 0 ? <p>Nenhuma prospecção nesta etapa.</p> : (
                    <ul className="lead-list">
                      {column.map((prospect) => (
                        <li key={prospect.id}>
                          <div className="lead-list__heading">
                            <strong>{prospect.fullName}</strong>
                            <StatusBadge tone={stageTone(prospect.stage)}>{stageLabels[prospect.stage]}</StatusBadge>
                          </div>
                          <p>{contactValue(prospect, 'phone') || contactValue(prospect, 'email') || 'Sem contato informado'}</p>
                          <dl>
                            <div><dt>Origem</dt><dd>{prospect.source}</dd></div>
                            <div><dt>Responsável</dt><dd>{prospect.owner?.displayName ?? 'Não atribuído'}</dd></div>
                            <div><dt>Próxima ação</dt><dd>{nextActionText(prospect)}</dd></div>
                          </dl>
                          <div className="lead-list__actions">
                            <Button type="button" variant="secondary" onClick={() => void openHistory(prospect)}>Histórico</Button>
                            {canManage && prospect.stage !== 'converted' && <>
                              <Button type="button" variant="secondary" onClick={() => setScreen({ type: 'interaction', prospect, back: 'board' })}>Registrar contato</Button>
                              <Button type="button" variant="secondary" onClick={() => openEditProspect(prospect)}>Editar</Button>
                            </>}
                            {canConvert && prospect.stage !== 'converted' && (
                              <Button type="button" onClick={() => setScreen({ type: 'conversion', prospect })}>Converter em cliente</Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </section>
        )}
        {canRead && totalPages > 1 && (
          <nav className="lead-pagination" aria-label="Paginação de prospecções">
            <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</Button>
            <span>Página {page} de {totalPages}</span>
            <Button type="button" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</Button>
          </nav>
        )}
      </Card>
      )}
    </section>
  )
}
