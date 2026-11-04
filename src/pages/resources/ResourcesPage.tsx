import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, useAuth } from '@/features/auth'
import {
  createResource,
  listResources,
  updateResource,
  type EquipmentResource,
  type ResourceCatalog,
  type ResourceInput,
  type ResourceKind,
  type ResourceRecord,
  type ResourceStatusFilter,
  type RoomResource,
  type ServiceResource,
} from '@/features/resources'
import { Button, Card, EmptyState, ErrorState, Icon, LoadingState, StatusBadge } from '@/shared/ui'
import './ResourcesPage.css'

const emptyCatalog: ResourceCatalog = { modalities: [], services: [], rooms: [], equipment: [], units: [] }
const kindLabels: Record<ResourceKind, { label: string; singular: string }> = {
  modalities: { label: 'Modalidades', singular: 'modalidade' },
  services: { label: 'Serviços', singular: 'serviço' },
  rooms: { label: 'Salas', singular: 'sala' },
  equipment: { label: 'Aparelhos', singular: 'aparelho' },
}
const kinds = Object.keys(kindLabels) as ResourceKind[]

type ResourceScreen = { type: 'list' } | { type: 'composer'; resource: ResourceRecord | null }

function inputFromForm(kind: ResourceKind, form: HTMLFormElement): ResourceInput {
  const data = new FormData(form)
  const common = { name: String(data.get('name') ?? ''), active: data.get('active') === 'on' }
  if (kind === 'services') return {
    ...common,
    modalityId: String(data.get('modalityId') ?? ''),
    durationMinutes: Number(data.get('durationMinutes')),
    defaultCapacity: Number(data.get('defaultCapacity')),
  }
  if (kind === 'rooms') return {
    ...common, unitId: String(data.get('unitId') ?? ''), capacity: Number(data.get('capacity')),
  }
  if (kind === 'equipment') return {
    ...common, unitId: String(data.get('unitId') ?? ''), quantity: Number(data.get('quantity')),
  }
  return common
}

function inputFromResource(kind: ResourceKind, resource: ResourceRecord, active: boolean): ResourceInput {
  const common = { name: resource.name, active }
  if (kind === 'services') {
    const service = resource as ServiceResource
    return { ...common, modalityId: service.modalityId, durationMinutes: service.durationMinutes, defaultCapacity: service.defaultCapacity }
  }
  if (kind === 'rooms') {
    const room = resource as RoomResource
    return { ...common, unitId: room.unitId, capacity: room.capacity }
  }
  if (kind === 'equipment') {
    const item = resource as EquipmentResource
    return { ...common, unitId: item.unitId, quantity: item.quantity }
  }
  return common
}

function detail(kind: ResourceKind, resource: ResourceRecord) {
  if (kind === 'services') {
    const service = resource as ServiceResource
    return `${service.modalityName} · ${service.durationMinutes} min · capacidade ${service.defaultCapacity}`
  }
  if (kind === 'rooms') {
    const room = resource as RoomResource
    return `${room.unitName} · capacidade ${room.capacity}`
  }
  if (kind === 'equipment') {
    const item = resource as EquipmentResource
    return `${item.unitName} · ${item.quantity} ${item.quantity === 1 ? 'disponível' : 'disponíveis'}`
  }
  return `${resource.associationsCount} serviço${resource.associationsCount === 1 ? '' : 's'} vinculado${resource.associationsCount === 1 ? '' : 's'}`
}

export function ResourcesPage() {
  const { session } = useAuth()
  const [catalog, setCatalog] = useState<ResourceCatalog>(emptyCatalog)
  const [kind, setKind] = useState<ResourceKind>('services')
  const [status, setStatus] = useState<ResourceStatusFilter>('all')
  const [screen, setScreen] = useState<ResourceScreen>({ type: 'list' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const canRead = organization?.permissions.includes('resources.read') ?? false
  const canManage = organization?.permissions.includes('resources.manage') ?? false
  const records = catalog[kind] as ResourceRecord[]

  async function load() {
    if (!session?.organizationId || !canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setCatalog(await listResources(session.organizationId, status))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar os recursos.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setScreen({ type: 'list' })
    setMessage(null)
    void load()
  }, [session?.organizationId, canRead, status])

  function openComposer(resource: ResourceRecord | null = null) {
    setError(null)
    setScreen({ type: 'composer', resource })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    setSaving(true)
    setError(null)
    try {
      const input = inputFromForm(kind, event.currentTarget)
      if (editing) await updateResource(session.organizationId, kind, editing.id, input)
      else await createResource(session.organizationId, kind, input)
      const feminine = kind === 'modalities' || kind === 'rooms'
      const outcome = editing
        ? feminine ? 'atualizada' : 'atualizado'
        : feminine ? 'cadastrada' : 'cadastrado'
      setMessage(`${kindLabels[kind].singular[0].toUpperCase()}${kindLabels[kind].singular.slice(1)} ${outcome} com sucesso.`)
      setScreen({ type: 'list' })
      await load()
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Não foi possível salvar o recurso.')
    } finally {
      setSaving(false)
    }
  }

  async function toggle(resource: ResourceRecord) {
    if (!session?.organizationId) return
    setSaving(true)
    setError(null)
    try {
      await updateResource(session.organizationId, kind, resource.id, inputFromResource(kind, resource, !resource.active))
      const feminine = kind === 'modalities' || kind === 'rooms'
      const verb = resource.active
        ? feminine ? 'inativada' : 'inativado'
        : feminine ? 'ativada' : 'ativado'
      setMessage(`${resource.name} foi ${verb}.`)
      await load()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a situação.')
    } finally {
      setSaving(false)
    }
  }

  const editing = screen.type === 'composer' ? screen.resource : null
  const serviceEditing = editing as ServiceResource | null
  const roomEditing = editing as RoomResource | null
  const equipmentEditing = editing as EquipmentResource | null

  return (
    <section className="resources-page" aria-labelledby="resources-title">
      <header className="resources-page__header">
        <div><span>Agenda · Configuração</span><h1 id="resources-title">Recursos operacionais</h1><p>Organize serviços, modalidades, salas e aparelhos de {organization?.name}.</p></div>
        {screen.type === 'list' && canManage && <Button type="button" onClick={() => openComposer()}>Novo recurso</Button>}
      </header>

      {message && <p className="resources-page__message" role="status">{message}</p>}
      {error && <ErrorState compact title="Não foi possível concluir" description={error} />}

      {screen.type === 'composer' && (
        <button type="button" className="resource-back" onClick={() => { setError(null); setScreen({ type: 'list' }) }}>
          <Icon name="chevron-left" />
          Voltar para os recursos
        </button>
      )}

      {screen.type === 'list' && (
      <div className="resource-tabs" role="tablist" aria-label="Tipos de recurso">
        {kinds.map((item) => <button key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => { setKind(item); setScreen({ type: 'list' }) }}>{kindLabels[item].label}<strong>{catalog[item].length}</strong></button>)}
      </div>
      )}

      {screen.type === 'composer' && canManage && (
        <Card title={`${editing ? 'Editar' : kind === 'modalities' || kind === 'rooms' ? 'Nova' : 'Novo'} ${kindLabels[kind].singular}`} description="Os itens inativos permanecem no histórico, mas deixam de ser oferecidos para novos agendamentos.">
          <form key={`${kind}:${editing?.id ?? 'new'}`} className="resource-form" onSubmit={save}>
            <label>Nome<input name="name" required minLength={2} maxLength={120} defaultValue={editing?.name} /></label>
            {kind === 'services' && <>
              <label>Modalidade<select name="modalityId" required defaultValue={serviceEditing?.modalityId ?? ''}><option value="" disabled>Selecione</option>{catalog.modalities.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (inativa)'}</option>)}</select></label>
              <label>Duração em minutos<input name="durationMinutes" type="number" required min={5} max={1440} defaultValue={serviceEditing?.durationMinutes ?? 50} /></label>
              <label>Capacidade padrão<input name="defaultCapacity" type="number" required min={1} max={10000} defaultValue={serviceEditing?.defaultCapacity ?? 1} /></label>
            </>}
            {(kind === 'rooms' || kind === 'equipment') && <label>Unidade<select name="unitId" required defaultValue={(kind === 'rooms' ? roomEditing?.unitId : equipmentEditing?.unitId) ?? ''}><option value="" disabled>Selecione</option>{catalog.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}{unit.active ? '' : ' (inativa)'}</option>)}</select></label>}
            {kind === 'rooms' && <label>Capacidade<input name="capacity" type="number" required min={1} max={10000} defaultValue={roomEditing?.capacity ?? 1} /></label>}
            {kind === 'equipment' && <label>Quantidade disponível<input name="quantity" type="number" required min={1} max={10000} defaultValue={equipmentEditing?.quantity ?? 1} /></label>}
            <label className="resource-form__active"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} /> Ativo para novos agendamentos</label>
            <div className="resource-form__actions"><Button type="submit" loading={saving}>Salvar recurso</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => { setError(null); setScreen({ type: 'list' }) }}>Cancelar</Button></div>
          </form>
        </Card>
      )}

      {screen.type === 'list' && (
      <Card title={kindLabels[kind].label} description="As associações existentes são preservadas ao inativar um item.">
        {canRead && <div className="resource-filter" aria-label="Filtrar por situação">{(['all', 'active', 'inactive'] as ResourceStatusFilter[]).map((value) => <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{value === 'all' ? 'Todos' : value === 'active' ? 'Ativos' : 'Inativos'}</button>)}</div>}
        {loading ? <LoadingState title="Carregando recursos…" /> : !canRead ? <EmptyState title="Acesso restrito" description="Sua função não permite consultar os recursos desta organização." /> : records.length === 0 ? <EmptyState title={`Nenhum item em ${kindLabels[kind].label.toLowerCase()}`} description="Cadastre o primeiro recurso para preparar a agenda." action={canManage ? <Button type="button" onClick={() => openComposer()}>Novo recurso</Button> : undefined} /> : (
          <ul className="resource-list" aria-label={kindLabels[kind].label}>
            {records.map((resource) => <li key={resource.id}><div><span><strong>{resource.name}</strong><StatusBadge tone={resource.active ? 'success' : 'neutral'}>{resource.active ? 'Ativo' : 'Inativo'}</StatusBadge></span><p>{detail(kind, resource)}</p>{kind !== 'modalities' && <small>{resource.associationsCount} agendamento{resource.associationsCount === 1 ? '' : 's'} associado{resource.associationsCount === 1 ? '' : 's'}</small>}</div>{canManage && <div className="resource-list__actions"><Button type="button" variant="secondary" onClick={() => openComposer(resource)}>Editar</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => void toggle(resource)}>{resource.active ? 'Inativar' : 'Ativar'}</Button></div>}</li>)}
          </ul>
        )}
      </Card>
      )}
    </section>
  )
}
