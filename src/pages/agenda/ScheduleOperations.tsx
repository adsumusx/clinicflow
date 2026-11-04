import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, useAuth } from '@/features/auth'
import {
  addAppointmentParticipant, cancelAppointment, createAppointment,
  createAppointmentSeries, createAvailability, createClassAppointment, getSchedule, listAvailability,
  updateAppointment, updateAppointmentOccurrences, updateAppointmentParticipantStatus, updateAvailability,
  type AppointmentRecord, type AvailabilityKind,
  type AvailabilityPayload, type AvailabilityRule, type SchedulePayload,
} from '@/features/schedule'
import { Button, Card, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/shared/ui'

const weekdays = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
const kinds: Record<AvailabilityKind, string> = {
  working_hours: 'Expediente', break: 'Intervalo', unavailable: 'Indisponibilidade', vacation: 'Férias',
}
const participantStates = {
  booked: 'Reservado', confirmed: 'Confirmado', attended: 'Presente',
  absent: 'Falta', cancelled: 'Cancelado',
} as const
const localValue = (value: string) => {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
function parseLocalDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

const scheduleSpanMs = 90 * 24 * 60 * 60 * 1000

function scheduleWindow(visibleFrom?: string, visibleTo?: string, extraStart?: string) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  let from = visibleFrom ? parseLocalDate(visibleFrom) : startOfToday
  const weekEnd = visibleTo ? parseLocalDate(visibleTo) : from
  let to = new Date(Math.max(from.getTime() + scheduleSpanMs, weekEnd.getTime()))
  if (extraStart) {
    const extra = new Date(extraStart)
    if (!Number.isNaN(extra.getTime())) {
      const extraDay = new Date(extra.getFullYear(), extra.getMonth(), extra.getDate())
      if (extraDay < from) from = extraDay
      if (extra > to) to = extra
      if (to.getTime() - from.getTime() > scheduleSpanMs) {
        if (extraDay < parseLocalDate(visibleFrom ?? formatFallback(startOfToday))) {
          to = new Date(from.getTime() + scheduleSpanMs)
        } else {
          from = new Date(to.getTime() - scheduleSpanMs)
        }
      }
    }
  }
  return { from: from.toISOString(), to: to.toISOString() }
}

function formatFallback(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
const clock = (value: string | null) => {
  const time = value?.slice(0, 5) ?? ''
  return time || null
}
const toAvailabilityInput = (item: AvailabilityRule, active = item.active) => {
  const weekly = item.kind === 'working_hours' || item.kind === 'break'
  return {
    active, kind: item.kind, label: item.label,
    professionalId: item.professionalId, unitId: item.unitId, timezone: item.timezone,
    weekday: weekly ? item.weekday : null,
    localStartTime: weekly ? clock(item.localStartTime) : null,
    localEndTime: weekly ? clock(item.localEndTime) : null,
    startsAt: weekly ? null : item.startsAt,
    endsAt: weekly ? null : item.endsAt,
  }
}

interface ScheduleOperationsProps {
  visibleFrom?: string
  visibleTo?: string
  preferredDate?: string
  onAppointments?: (items: AppointmentRecord[]) => void
}

export function ScheduleOperations({
  visibleFrom,
  visibleTo,
  preferredDate,
  onAppointments,
}: ScheduleOperationsProps = {}) {
  const { session } = useAuth()
  const [schedule, setSchedule] = useState<SchedulePayload | null>(null)
  const [availability, setAvailability] = useState<AvailabilityPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [appointmentEditor, setAppointmentEditor] = useState(false)
  const [appointmentMode, setAppointmentMode] = useState<'individual' | 'class' | 'series'>('individual')
  const [ruleEditor, setRuleEditor] = useState(false)
  const [appointment, setAppointment] = useState<AppointmentRecord | null>(null)
  const [rule, setRule] = useState<AvailabilityRule | null>(null)
  const [ruleKind, setRuleKind] = useState<AvailabilityKind>('working_hours')
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const canRead = organization?.permissions.includes('schedule.read') ?? false
  const canManage = organization?.permissions.includes('schedule.manage') ?? false

  async function load(extraStart?: string) {
    if (!session?.organizationId || !canRead) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const dates = scheduleWindow(visibleFrom, visibleTo, extraStart)
      const [nextSchedule, nextAvailability] = await Promise.all([
        getSchedule(session.organizationId, dates.from, dates.to), listAvailability(session.organizationId),
      ])
      if (Array.isArray(nextSchedule.appointments) && Array.isArray(nextAvailability.rules)) {
        setSchedule(nextSchedule); setAvailability(nextAvailability)
        onAppointments?.(nextSchedule.appointments)
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar a agenda operacional.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [session?.organizationId, canRead, visibleFrom, visibleTo])

  async function saveAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    const data = new FormData(event.currentTarget)
    const baseInput = {
      unitId: String(data.get('unitId')), serviceId: String(data.get('serviceId')),
      professionalId: String(data.get('professionalId')),
      roomId: String(data.get('roomId') || '') || null,
      startsAt: new Date(String(data.get('startsAt'))).toISOString(),
      equipment: data.getAll('equipmentIds').map((equipmentId) => ({
        equipmentId: String(equipmentId),
        quantity: Number(data.get(`equipmentQuantity:${String(equipmentId)}`)),
      })),
    }
    setError(null)
    try {
      if (appointment?.recurrence) {
        await updateAppointmentOccurrences(session.organizationId, appointment.id, {
          ...baseInput, clientId: String(data.get('clientId')),
          scope: String(data.get('scope')) as 'single' | 'future',
        })
      } else if (appointment) {
        await updateAppointment(session.organizationId, appointment.id, {
          ...baseInput, clientId: String(data.get('clientId')),
        })
      } else if (appointmentMode === 'class') {
        await createClassAppointment(session.organizationId, {
          ...baseInput, capacity: Number(data.get('capacity')),
          clientIds: data.getAll('clientIds').map(String),
        })
      } else if (appointmentMode === 'series') {
        await createAppointmentSeries(session.organizationId, {
          ...baseInput, clientId: String(data.get('clientId')),
          recurrence: {
            frequency: 'weekly', interval: Number(data.get('interval')),
            count: Number(data.get('count')), timezone: String(data.get('timezone')),
          },
        })
      } else {
        await createAppointment(session.organizationId, {
          ...baseInput, clientId: String(data.get('clientId')),
        })
      }
      setMessage(appointment ? 'Agendamento alterado com sucesso.' : 'Agendamento criado com sucesso.')
      setAppointmentEditor(false); setAppointment(null); await load(String(data.get('startsAt') ?? ''))
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Não foi possível salvar o agendamento.')
    }
  }

  async function addParticipant(event: FormEvent<HTMLFormElement>, item: AppointmentRecord) {
    event.preventDefault()
    if (!session?.organizationId) return
    const clientId = String(new FormData(event.currentTarget).get('clientId'))
    try {
      await addAppointmentParticipant(session.organizationId, item.id, clientId)
      setMessage('Participante incluído na turma.'); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível incluir.') }
  }

  async function markParticipant(
    item: AppointmentRecord, participantId: string,
    status: 'confirmed' | 'attended' | 'absent' | 'cancelled',
  ) {
    if (!session?.organizationId) return
    try {
      await updateAppointmentParticipantStatus(session.organizationId, item.id, participantId, status)
      setMessage(`Situação registrada: ${participantStates[status].toLowerCase()}.`); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a situação.') }
  }

  async function removeAppointment(item: AppointmentRecord) {
    if (!session?.organizationId) return
    try {
      await cancelAppointment(session.organizationId, item.id)
      setMessage('Agendamento cancelado sem apagar o histórico.'); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível cancelar.') }
  }

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.organizationId) return
    const data = new FormData(event.currentTarget)
    const kind = String(data.get('kind')) as AvailabilityKind
    const weekly = kind === 'working_hours' || kind === 'break'
    const parseIsoDate = (val: FormDataEntryValue | null) => {
      if (!val) return null
      const parsed = new Date(String(val))
      return isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
    const input = {
      active: rule?.active ?? true, kind, label: String(data.get('label') || '') || null,
      professionalId: String(data.get('professionalId')), unitId: String(data.get('unitId')),
      timezone: String(data.get('timezone')), weekday: weekly ? Number(data.get('weekday')) : null,
      localStartTime: weekly ? clock(String(data.get('localStartTime') ?? '')) : null,
      localEndTime: weekly ? clock(String(data.get('localEndTime') ?? '')) : null,
      startsAt: weekly ? null : parseIsoDate(data.get('startsAt')),
      endsAt: weekly ? null : parseIsoDate(data.get('endsAt')),
    }
    setError(null)
    try {
      if (rule) await updateAvailability(session.organizationId, rule.id, input)
      else await createAvailability(session.organizationId, input)
      setMessage(rule ? 'Disponibilidade alterada com sucesso.' : 'Disponibilidade cadastrada com sucesso.')
      setRuleEditor(false); setRule(null); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar a regra.') }
  }

  async function toggleRule(item: AvailabilityRule) {
    if (!session?.organizationId) return
    setError(null)
    try {
      await updateAvailability(session.organizationId, item.id, toAvailabilityInput(item, !item.active))
      setMessage(`Regra ${item.active ? 'inativada' : 'ativada'} com sucesso.`); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a regra.') }
  }

  const creatingAppointment = appointmentEditor && !appointment
  const creatingRule = ruleEditor && !rule
  function selectAppointmentMode(mode: 'individual' | 'class' | 'series') {
    setError(null)
    setRuleEditor(false)
    setRule(null)
    if (creatingAppointment && appointmentMode === mode) {
      setAppointmentEditor(false)
      return
    }
    setAppointment(null)
    setAppointmentMode(mode)
    setAppointmentEditor(true)
  }
  function selectAvailability() {
    setError(null)
    setAppointmentEditor(false)
    setAppointment(null)
    if (creatingRule) {
      setRuleEditor(false)
      return
    }
    setRule(null)
    setRuleKind('working_hours')
    setRuleEditor(true)
  }

  if (!canRead) return null
  if (loading) return <LoadingState title="Carregando agenda operacional…" />
  if (!schedule || !availability) return error ? <ErrorState compact title="Agenda indisponível" description={error} /> : null
  const weeklyRule = ruleKind === 'working_hours' || ruleKind === 'break'
  const visibleAppointments = schedule.appointments.filter(({ status }) => status !== 'cancelled')
  const selectableClients = appointmentMode === 'series' || appointment?.recurrence
    ? schedule.clients.filter(({ clientType }) => clientType === 'fixed') : schedule.clients

  return <section className="schedule-operations" aria-labelledby="schedule-operations-title">
    <header><div><span>Dados em tempo real</span><h2 id="schedule-operations-title">Agenda operacional</h2><p>A semana aberta e os 90 dias seguintes, com disponibilidade e conflitos validados no servidor.</p></div>{canManage && <div><Button type="button" variant="secondary" aria-pressed={creatingAppointment && appointmentMode === 'individual'} onClick={() => selectAppointmentMode('individual')}>Novo individual</Button><Button type="button" variant="secondary" aria-pressed={creatingAppointment && appointmentMode === 'class'} onClick={() => selectAppointmentMode('class')}>Nova turma</Button><Button type="button" variant="secondary" aria-pressed={creatingAppointment && appointmentMode === 'series'} onClick={() => selectAppointmentMode('series')}>Nova série</Button><Button type="button" variant="secondary" aria-pressed={creatingRule} onClick={selectAvailability}>Disponibilidade</Button></div>}</header>
    {message && <p className="schedule-operations__message" role="status">{message}</p>}
    {error && <ErrorState compact title="Não foi possível concluir" description={error} />}

    {appointmentEditor && <Card title={appointment ? 'Alterar agendamento' : appointmentMode === 'class' ? 'Nova turma' : appointmentMode === 'series' ? 'Nova série semanal' : 'Novo agendamento individual'} description="O término é calculado pela duração do serviço."><form key={`${appointment?.id ?? 'new'}-${appointmentMode}`} className="schedule-form" onSubmit={saveAppointment}>
      {appointmentMode === 'class' && !appointment ? <label>Participantes iniciais<select name="clientIds" multiple>{schedule.clients.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}</select></label> : <label>Cliente<select name="clientId" required defaultValue={appointment?.client?.id ?? ''}><option value="" disabled>Selecione</option>{selectableClients.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}</select></label>}
      <label>Profissional<select name="professionalId" required defaultValue={appointment?.professional.id ?? ''}><option value="" disabled>Selecione</option>{schedule.professionals.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label>Unidade<select name="unitId" required defaultValue={appointment?.unit.id ?? ''}><option value="" disabled>Selecione</option>{schedule.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Serviço<select name="serviceId" required defaultValue={appointment?.service.id ?? ''}><option value="" disabled>Selecione</option>{schedule.services.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.durationMinutes} min</option>)}</select></label>
      <label>Sala<select name="roomId" defaultValue={appointment?.room?.id ?? ''}><option value="">Sem sala</option>{schedule.rooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <fieldset className="schedule-equipment"><legend>Aparelhos</legend>{schedule.equipment.length === 0 ? <small>Nenhum aparelho ativo.</small> : schedule.equipment.map((item) => { const selected = appointment?.equipment.find(({ id }) => id === item.id); return <div key={item.id}><label><input type="checkbox" name="equipmentIds" value={item.id} defaultChecked={Boolean(selected)} /> {item.name}</label><input aria-label={`Quantidade de ${item.name}`} name={`equipmentQuantity:${item.id}`} type="number" min="1" max={item.quantity} defaultValue={selected?.quantity ?? 1} /></div> })}</fieldset>
      <label>Início<input name="startsAt" type="datetime-local" required defaultValue={appointment ? localValue(appointment.startsAt) : (preferredDate ? `${preferredDate}T10:00` : '')} /></label>
      {appointmentMode === 'class' && !appointment && <label>Capacidade<input name="capacity" type="number" min="2" max="10000" required defaultValue="4" /></label>}
      {appointmentMode === 'series' && !appointment && <><label>Intervalo em semanas<input name="interval" type="number" min="1" max="52" required defaultValue="1" /></label><label>Ocorrências<input name="count" type="number" min="2" max="104" required defaultValue="4" /></label><label>Fuso IANA<input name="timezone" required defaultValue="America/Sao_Paulo" /></label></>}
      {appointment?.recurrence && <label>Aplicar alteração<select name="scope" defaultValue="single"><option value="single">Somente esta ocorrência</option><option value="future">Esta e as futuras</option></select></label>}
      <div><Button type="submit">Salvar agendamento</Button><Button type="button" variant="secondary" onClick={() => setAppointmentEditor(false)}>Fechar</Button></div>
    </form></Card>}

    {visibleAppointments.some((item) => (item.waitlist?.length ?? 0) > 0) && <Card title="Filas de interesse" description="A ordem é preservada e somente uma vaga é oferecida por turma."><ul className="schedule-list">{visibleAppointments.flatMap((item) => (item.waitlist ?? []).map((entry) => <li key={entry.id}><div><strong>{item.service.name} · {entry.position}º</strong><span>{entry.client.fullName}</span><small>{entry.status === 'offered' ? `Oferta ativa até ${new Date(entry.offer!.expiresAt).toLocaleString('pt-BR')}` : 'Aguardando uma vaga'}</small></div></li>))}</ul></Card>}

    {ruleEditor && <Card title={rule ? 'Alterar disponibilidade' : 'Nova disponibilidade'} description="Expedientes e intervalos são semanais; férias e indisponibilidades usam datas."><form key={rule?.id ?? 'new-rule'} className="schedule-form" onSubmit={saveRule}>
      <label>Tipo<select name="kind" value={ruleKind} onChange={(event) => setRuleKind(event.target.value as AvailabilityKind)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Profissional<select name="professionalId" required defaultValue={rule?.professionalId ?? ''}><option value="" disabled>Selecione</option>{availability.professionals.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label>Unidade<select name="unitId" required defaultValue={rule?.unitId ?? ''}><option value="" disabled>Selecione</option>{availability.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Descrição<input name="label" minLength={2} maxLength={120} defaultValue={rule?.label ?? ''} /></label><input name="timezone" type="hidden" value={rule?.timezone ?? 'America/Sao_Paulo'} readOnly />
      {weeklyRule ? <><label>Dia<select name="weekday" defaultValue={rule?.weekday ?? 1}>{weekdays.slice(1).map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label><label>Início<input name="localStartTime" type="time" defaultValue={rule?.localStartTime?.slice(0, 5) ?? '08:00'} /></label><label>Fim<input name="localEndTime" type="time" defaultValue={rule?.localEndTime?.slice(0, 5) ?? '18:00'} /></label></> : <><label>Início<input name="startsAt" type="datetime-local" defaultValue={rule?.startsAt ? localValue(rule.startsAt) : ''} /></label><label>Fim<input name="endsAt" type="datetime-local" defaultValue={rule?.endsAt ? localValue(rule.endsAt) : ''} /></label></>}
      <div><Button type="submit">Salvar disponibilidade</Button><Button type="button" variant="secondary" onClick={() => setRuleEditor(false)}>Fechar</Button></div>
    </form></Card>}

    <div className="schedule-operations__grid"><Card title="Agendamentos, turmas e séries" description="Recursos, capacidade e estados são validados de forma atômica.">{visibleAppointments.length === 0 ? <EmptyState title="Nenhum agendamento no período" description="Crie um atendimento, uma turma ou uma série semanal." /> : <ul className="schedule-list">{visibleAppointments.map((item) => <li key={item.id}><div><strong>{item.service.name} <StatusBadge tone={item.status === 'completed' ? 'success' : 'neutral'}>{item.status === 'completed' ? 'Concluído' : 'Agendado'}</StatusBadge> {item.appointmentType === 'class' && <StatusBadge tone={item.occupancy >= item.capacity ? 'warning' : 'success'}>{item.occupancy}/{item.capacity} vagas</StatusBadge>} {item.recurrence && <StatusBadge tone="neutral">Série · {item.recurrence.occurrenceIndex + 1}/{item.recurrence.count}</StatusBadge>}</strong><span>{new Date(item.startsAt).toLocaleString('pt-BR')} · {item.appointmentType === 'class' ? `${item.occupancy} participantes` : item.client?.fullName}</span><small>{item.professional.displayName} · {item.unit.name}{item.room ? ` · ${item.room.name}` : ''}{item.equipment.length ? ` · ${item.equipment.map(({ name, quantity }) => `${quantity}× ${name}`).join(', ')}` : ''}</small><div>{item.participants.map((participant) => <span key={participant.id}>{participant.client.fullName} · {participantStates[participant.status]} {canManage && item.status === 'scheduled' && (participant.status === 'booked' || participant.status === 'confirmed') && <>{participant.status === 'booked' && <button type="button" className="schedule-inline-action" onClick={() => void markParticipant(item, participant.id, 'confirmed')}>confirmar</button>}<button type="button" className="schedule-inline-action" onClick={() => void markParticipant(item, participant.id, 'attended')}>presente</button><button type="button" className="schedule-inline-action" onClick={() => void markParticipant(item, participant.id, 'absent')}>falta</button><button type="button" className="schedule-inline-action" onClick={() => void markParticipant(item, participant.id, 'cancelled')}>cancelar</button></>}{participant.status === 'attended' && <button type="button" className="schedule-inline-action" title="Lançar recebimento no Financeiro" onClick={() => { sessionStorage.setItem('prefill_receivable', JSON.stringify({ clientId: participant.client.id, description: `${item.service.name} · ${participant.client.fullName}` })); window.location.hash = 'finance' }}>cobrar / nota</button>}</span>)}{item.appointmentType === 'class' && canManage && item.status === 'scheduled' && item.occupancy < item.capacity && <form className="schedule-participant-form" onSubmit={(event) => void addParticipant(event, item)}><select name="clientId" required defaultValue=""><option value="" disabled>Adicionar cliente</option>{schedule.clients.filter((client) => !item.participants.some((participant) => participant.client.id === client.id && ['booked', 'confirmed', 'attended'].includes(participant.status))).map((client) => <option key={client.id} value={client.id}>{client.fullName}</option>)}</select><Button type="submit" variant="secondary">Incluir</Button></form>}</div></div>{canManage && item.status === 'scheduled' && <div>{item.appointmentType !== 'class' && <Button type="button" variant="secondary" onClick={() => { setAppointmentMode(item.recurrence ? 'series' : 'individual'); setAppointment(item); setAppointmentEditor(true) }}>Alterar</Button>}<Button type="button" variant="secondary" onClick={() => void removeAppointment(item)}>Cancelar</Button></div>}</li>)}</ul>}</Card>
      <Card title="Disponibilidade e bloqueios" description="Férias, pausas e indisponibilidades têm precedência.">{availability.rules.length === 0 ? <EmptyState title="Nenhum expediente cadastrado" description="Cadastre um horário profissional antes de agendar." /> : <ul className="schedule-list">{availability.rules.map((item) => <li key={item.id}><div><strong>{kinds[item.kind]} <StatusBadge tone={item.active ? 'success' : 'neutral'}>{item.active ? 'Ativa' : 'Inativa'}</StatusBadge></strong><span>{item.label ?? item.professionalName}</span><small>{item.weekday ? `${weekdays[item.weekday]}, ${item.localStartTime?.slice(0, 5)}–${item.localEndTime?.slice(0, 5)}` : `${new Date(item.startsAt!).toLocaleString('pt-BR')}–${new Date(item.endsAt!).toLocaleString('pt-BR')}`} · {item.unitName}</small></div>{canManage && <div><Button type="button" variant="secondary" onClick={() => { setRule(item); setRuleKind(item.kind); setRuleEditor(true) }}>Editar</Button><Button type="button" variant="secondary" onClick={() => void toggleRule(item)}>{item.active ? 'Inativar' : 'Ativar'}</Button></div>}</li>)}</ul>}</Card></div>
  </section>
}
