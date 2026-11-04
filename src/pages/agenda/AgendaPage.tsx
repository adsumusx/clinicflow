import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Icon, SuccessState } from '@/shared/ui'
import type { AppointmentRecord } from '@/features/schedule'
import { ScheduleOperations } from './ScheduleOperations'
import './AgendaPage.css'

interface AgendaDay {
  weekday: string
  day: number
  iso: string
  fullLabel: string
  today?: boolean
  appointmentCount: number
  nextFree: string
  occupancy: string
}

interface CreatedAppointment {
  id: string
  client: string
  service: string
  date: string
  time: string
  room: string
}

type TimelineSlot =
  | { id: string; time: string; variant: 'completed'; title: string }
  | {
      id: string
      time: string
      variant: 'featured'
      title: string
      place: string
      duration: string
      badge: string
      full: boolean
      attendees: string[]
      waitlist: number
    }
  | {
      id: string
      time: string
      variant: 'client'
      title: string
      place: string
      badge: string
      client: string
      initials: string
      note: string
    }
  | { id: string; time: string; variant: 'empty' }
  | {
      id: string
      time: string
      variant: 'created'
      title: string
      place: string
      duration: string
      client: string
      initials: string
    }

const demoWeekMonday = '2026-08-31'
const demoToday = '2026-09-01'

const demoDays: AgendaDay[] = [
  { weekday: 'Seg', day: 31, iso: '2026-08-31', fullLabel: 'segunda-feira, 31 de agosto', appointmentCount: 8, nextFree: '14:00', occupancy: '54%' },
  { weekday: 'Ter', day: 1, iso: '2026-09-01', fullLabel: 'terça-feira, 1 de setembro', today: true, appointmentCount: 12, nextFree: '10:00', occupancy: '78%' },
  { weekday: 'Qua', day: 2, iso: '2026-09-02', fullLabel: 'quarta-feira, 2 de setembro', appointmentCount: 9, nextFree: '11:00', occupancy: '64%' },
  { weekday: 'Qui', day: 3, iso: '2026-09-03', fullLabel: 'quinta-feira, 3 de setembro', appointmentCount: 6, nextFree: '09:00', occupancy: '41%' },
  { weekday: 'Sex', day: 4, iso: '2026-09-04', fullLabel: 'sexta-feira, 4 de setembro', appointmentCount: 10, nextFree: '15:00', occupancy: '83%' },
]

const serviceDurations: Record<string, string> = {
  'Avaliação postural': '50 min',
  Fisioterapia: '50 min',
  'Pilates individual': '60 min',
}

const schedules: Record<string, TimelineSlot[]> = {
  '2026-08-31': [
    { id: 'mon-1', time: '07:30', variant: 'completed', title: 'Alongamento matinal' },
    { id: 'mon-2', time: '13:00', variant: 'client', title: 'Reavaliação', place: 'Consultório 2', badge: 'Confirmado', client: 'Helena Prado', initials: 'HP', note: 'retorno' },
    { id: 'mon-3', time: '14:00', variant: 'empty' },
  ],
  '2026-09-01': [
    { id: 'tue-1', time: '07:00', variant: 'completed', title: 'Personal Training' },
    {
      id: 'tue-2', time: '08:00', variant: 'featured', title: 'Pilates em Grupo',
      place: 'Estúdio Principal', duration: '60 min', badge: 'Lotado (4/4)', full: true,
      attendees: ['MS', 'JP', 'AC'], waitlist: 2,
    },
    {
      id: 'tue-3', time: '09:00', variant: 'client', title: 'Sessão Funcional',
      place: 'Estúdio Secundário', badge: '2 vagas', client: 'Carlos Eduardo', initials: 'CE', note: 'confirmado',
    },
    { id: 'tue-4', time: '10:00', variant: 'empty' },
  ],
  '2026-09-02': [
    { id: 'wed-1', time: '08:00', variant: 'completed', title: 'Mobilidade de coluna' },
    {
      id: 'wed-2', time: '09:30', variant: 'client', title: 'Fisioterapia individual',
      place: 'Consultório 1', badge: 'Confirmado', client: 'Marina Costa', initials: 'MC', note: 'sessão 4',
    },
    {
      id: 'wed-3', time: '11:00', variant: 'client', title: 'Pilates solo',
      place: 'Estúdio Principal', badge: '1 vaga', client: 'Paulo Henrique', initials: 'PH', note: 'confirmado',
    },
  ],
  '2026-09-03': [
    { id: 'thu-1', time: '09:00', variant: 'empty' },
    {
      id: 'thu-2', time: '10:30', variant: 'client', title: 'Grupo de mobilidade',
      place: 'Estúdio Principal', badge: '3 vagas', client: 'Rita Gomes', initials: 'RG', note: 'confirmada',
    },
  ],
  '2026-09-04': [
    {
      id: 'fri-1', time: '15:00', variant: 'empty',
    },
    {
      id: 'fri-2', time: '16:00', variant: 'client', title: 'Pilates clínico',
      place: 'Consultório 2', badge: 'Confirmado', client: 'João Batista', initials: 'JB', note: 'primeira consulta',
    },
  ],
}

const weekdayShort = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const weekdayLong = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
const monthLong = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

function parseIso(iso: string) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatIso(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function addDays(iso: string, amount: number) {
  const date = parseIso(iso)
  date.setDate(date.getDate() + amount)
  return formatIso(date)
}

function mondayOf(iso: string) {
  const date = parseIso(iso)
  const delta = date.getDay() === 0 ? -6 : 1 - date.getDay()
  return addDays(iso, delta)
}

function localDay(value: string) {
  const date = new Date(value)
  return formatIso(date)
}

function localClock(value: string) {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function buildDay(iso: string): AgendaDay {
  const fixture = demoDays.find((day) => day.iso === iso)
  if (fixture) return fixture
  const date = parseIso(iso)
  const day = date.getDate()
  const month = monthLong[date.getMonth()]
  return {
    weekday: weekdayShort[date.getDay()],
    day,
    iso,
    fullLabel: `${weekdayLong[date.getDay()]}, ${day} de ${month}`,
    appointmentCount: 0,
    nextFree: '09:00',
    occupancy: '0%',
  }
}

function weekOf(mondayIso: string) {
  return [0, 1, 2, 3, 4].map((offset) => buildDay(addDays(mondayIso, offset)))
}

function weekTitle(days: AgendaDay[]) {
  const first = parseIso(days[0].iso)
  const last = parseIso(days[days.length - 1].iso)
  const firstMonth = monthLong[first.getMonth()]
  const lastMonth = monthLong[last.getMonth()]
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
    return `${capitalize(lastMonth)} ${last.getFullYear()}`
  }
  if (first.getFullYear() === last.getFullYear()) {
    return `${capitalize(firstMonth)} — ${capitalize(lastMonth)} ${last.getFullYear()}`
  }
  return `${capitalize(firstMonth)} ${first.getFullYear()} — ${capitalize(lastMonth)} ${last.getFullYear()}`
}

function initials(name: string) {
  const letters = name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '')
  return letters.join('') || 'AG'
}

type AttendanceMark = 'confirmed' | 'available' | 'full' | 'done'

function attendanceMark(slot: TimelineSlot): AttendanceMark {
  if (slot.variant === 'completed') return 'done'
  if (slot.variant === 'featured') return slot.full ? 'full' : 'available'
  if (slot.variant === 'client' && /lotado/i.test(slot.badge)) return 'full'
  if (slot.variant === 'client' && /vaga/i.test(slot.badge)) return 'available'
  return 'confirmed'
}

function badgeClass(mark: AttendanceMark) {
  if (mark === 'full') return 'capacity-badge capacity-badge--full'
  if (mark === 'available') return 'capacity-badge capacity-badge--available'
  return 'capacity-badge'
}

function createdSlot(created: CreatedAppointment): TimelineSlot {
  return {
    id: created.id,
    time: created.time,
    variant: 'created',
    title: created.service,
    place: created.room,
    duration: serviceDurations[created.service] ?? '50 min',
    client: created.client,
    initials: initials(created.client),
  }
}

function slotFromRecord(item: AppointmentRecord): TimelineSlot {
  const time = localClock(item.startsAt)
  if (item.status === 'completed') {
    return { id: item.id, time, variant: 'completed', title: item.service.name }
  }
  const place = item.room?.name ?? item.unit.name
  const full = item.appointmentType === 'class' && item.occupancy >= item.capacity
  const badge = item.appointmentType === 'class'
    ? (full ? `Lotado (${item.occupancy}/${item.capacity})` : `${Math.max(item.capacity - item.occupancy, 0)} vagas`)
    : 'Confirmado'
  const names = item.appointmentType === 'class'
    ? item.participants.map((participant) => participant.client.fullName).filter(Boolean)
    : [item.client?.fullName ?? 'Paciente']
  return {
    id: item.id,
    time,
    variant: 'client',
    title: item.service.name,
    place: `${place} · ${item.service.durationMinutes} min`,
    badge,
    client: names.join(', ') || 'Turma',
    initials: initials(names[0] ?? 'Turma'),
    note: item.appointmentType === 'class' ? 'turma' : 'confirmado',
  }
}

function slotsFor(day: AgendaDay, created: CreatedAppointment[], operational: AppointmentRecord[]) {
  const base = schedules[day.iso] ?? [{ id: `${day.iso}-empty`, time: '09:00', variant: 'empty' as const }]
  let slots: TimelineSlot[] = [...base]
  for (const item of created.filter((entry) => entry.date === day.iso)) {
    slots = slots.filter((slot) => !(slot.variant === 'empty' && slot.time === item.time))
    slots.push(createdSlot(item))
  }
  for (const item of operational) {
    if (item.status === 'cancelled' || localDay(item.startsAt) !== day.iso || slots.some((slot) => slot.id === item.id)) continue
    slots.push(slotFromRecord(item))
  }
  return slots.sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id))
}

interface AgendaPageProps {
  openComposerRequest?: number
}

export function AgendaPage({ openComposerRequest = 0 }: AgendaPageProps) {
  const [weekMonday, setWeekMonday] = useState(demoWeekMonday)
  const [selectedIso, setSelectedIso] = useState(demoToday)
  const [waitlistNotified, setWaitlistNotified] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [createdAppointments, setCreatedAppointments] = useState<CreatedAppointment[]>([])
  const [operationalAppointments, setOperationalAppointments] = useState<AppointmentRecord[]>([])
  const weekDays = weekOf(weekMonday)
  const selectedDate = weekDays.find((date) => date.iso === selectedIso) ?? buildDay(selectedIso)
  const days = weekDays.some((date) => date.iso === selectedDate.iso) ? weekDays : [...weekDays, selectedDate]
  const visibleSlots = slotsFor(selectedDate, createdAppointments, operationalAppointments)
  const latestCreated = createdAppointments[createdAppointments.length - 1] ?? null
  const headingCount = schedules[selectedDate.iso]
    ? selectedDate.appointmentCount
    : visibleSlots.filter((slot) => slot.variant !== 'empty').length
  const rememberAppointments = useCallback((items: AppointmentRecord[]) => {
    setOperationalAppointments(items)
  }, [])

  useEffect(() => {
    if (openComposerRequest > 0) setComposerOpen(true)
  }, [openComposerRequest])

  function showDate(iso: string) {
    setWeekMonday(mondayOf(iso))
    setSelectedIso(iso)
  }

  function shiftWeek(direction: -1 | 1) {
    const current = parseIso(selectedIso)
    const monday = parseIso(weekMonday)
    const offset = Math.round((current.getTime() - monday.getTime()) / 86_400_000)
    const nextMonday = addDays(weekMonday, direction * 7)
    setWeekMonday(nextMonday)
    setSelectedIso(addDays(nextMonday, Math.min(Math.max(offset, 0), 4)))
  }

  function createAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const next = {
      id: `local-${createdAppointments.length + 1}-${String(data.get('date') ?? '')}-${String(data.get('time') ?? '')}`,
      client: String(data.get('client') ?? '').trim(),
      service: String(data.get('service') ?? ''),
      date: String(data.get('date') ?? ''),
      time: String(data.get('time') ?? ''),
      room: String(data.get('room') ?? ''),
    }
    setCreatedAppointments((current) => [...current, next])
    setComposerOpen(false)
    showDate(next.date)
  }

  function renderSlot(slot: TimelineSlot): ReactNode {
    if (slot.variant === 'completed') {
      return (
        <article className="appointment-card appointment-card--done appointment-card--completed">
          <h2><span className="appointment-mark appointment-mark--done" aria-hidden="true" />{slot.title}</h2>
          <p><Icon name="check" /> Concluído</p>
        </article>
      )
    }

    if (slot.variant === 'featured') {
      const mark = attendanceMark(slot)
      return (
        <article className={`appointment-card appointment-card--${mark} appointment-card--featured`}>
          <header>
            <div><h2><span className={`appointment-mark appointment-mark--${mark}`} aria-hidden="true" />{slot.title}</h2><p><Icon name="map-pin" /> {slot.place} · {slot.duration}</p></div>
            <span className={badgeClass(mark)}>{slot.badge}</span>
          </header>
          <div className="attendee-row" aria-label="4 alunos confirmados">
            {slot.attendees.map((letters, index) => (
              <span key={letters} className={`demo-avatar demo-avatar--${['one', 'two', 'three'][index] ?? 'more'}`}>{letters}</span>
            ))}
            <span className="demo-avatar demo-avatar--more">+1</span>
          </div>
          {slot.waitlist > 0 && (waitlistNotified ? (
            <SuccessState
              compact
              title="Notificação enviada aos interessados"
              description="A equipe acompanhará as confirmações da fila."
            />
          ) : (
            <div className="interest-banner">
              <Icon name="bell" />
              <div><strong>Aviso de interesse</strong><span>{slot.waitlist} alunos aguardam vaga</span></div>
              <button type="button" onClick={() => setWaitlistNotified(true)}>
                <Icon name="send" /> Notificar
              </button>
            </div>
          ))}
        </article>
      )
    }

    if (slot.variant === 'client') {
      const mark = attendanceMark(slot)
      return (
        <article className={`appointment-card appointment-card--${mark}`}>
          <header>
            <div><h2><span className={`appointment-mark appointment-mark--${mark}`} aria-hidden="true" />{slot.title}</h2><p><Icon name="map-pin" /> {slot.place}</p></div>
            <span className={badgeClass(mark)}>{slot.badge}</span>
          </header>
          <div className="client-confirmation">
            <span className="demo-avatar demo-avatar--four">{slot.initials}</span>
            <span><strong>{slot.client}</strong> {slot.note}</span>
          </div>
        </article>
      )
    }

    if (slot.variant === 'created') {
      return (
        <article className="appointment-card appointment-card--confirmed appointment-card--created" aria-live="polite">
          <header>
            <div><h2><span className="appointment-mark" aria-hidden="true" />{slot.title}</h2><p><Icon name="map-pin" /> {slot.place} · {slot.duration}</p></div>
            <span className="capacity-badge">Confirmado</span>
          </header>
          <div className="client-confirmation">
            <span className="demo-avatar demo-avatar--five">{slot.initials}</span>
            <span><strong>{slot.client}</strong> · {slot.time}</span>
          </div>
        </article>
      )
    }

    return (
      <button className="empty-slot" type="button" onClick={() => setComposerOpen(true)}>
        <span><Icon name="plus" /></span> Adicionar agendamento
      </button>
    )
  }

  return (
    <section className="agenda-page" aria-labelledby="agenda-title">
      <header className="page-heading agenda-heading">
        <div>
          <p className="page-heading__eyebrow">Clínica Serena · Centro</p>
          <h1 id="agenda-title">Agenda</h1>
          <p>{selectedDate.fullLabel} · {headingCount === 1 ? '1 atendimento' : `${headingCount} atendimentos`}</p>
        </div>
        <button className="agenda-heading__action" type="button" onClick={() => setComposerOpen(true)}>
          <Icon name="plus" /> Novo agendamento
        </button>
      </header>

      <div className="agenda-toolbar">
        <div className="agenda-toolbar__month">
          <button type="button" aria-label="Semana anterior" onClick={() => shiftWeek(-1)}><Icon name="chevron-left" /></button>
          <strong>{weekTitle(weekDays)}</strong>
          <button type="button" aria-label="Próxima semana" onClick={() => shiftWeek(1)}><Icon name="chevron-right" /></button>
        </div>
        <button className="agenda-toolbar__today" type="button" onClick={() => showDate(demoToday)}>Hoje</button>
      </div>

      <div className="date-picker" aria-label="Selecionar dia">
        {days.map((date) => {
          const selected = selectedIso === date.iso
          return (
            <button
              className={`date-picker__day${selected ? ' date-picker__day--selected' : ''}`}
              type="button"
              key={date.iso}
              aria-pressed={selected}
              onClick={() => setSelectedIso(date.iso)}
            >
              <span>{date.weekday}</span><strong>{date.day}</strong>{date.today && <i aria-label="Hoje" />}
            </button>
          )
        })}
      </div>

      {latestCreated && latestCreated.date === selectedDate.iso && (
        <SuccessState
          compact
          title="Agendamento confirmado"
          description={`${latestCreated.client} · ${latestCreated.service} às ${latestCreated.time} · ${latestCreated.room}`}
        />
      )}

      <div className="agenda-layout">
        <div className="agenda-timeline" aria-label={`Horários de ${selectedDate.fullLabel}`}>
          {visibleSlots.map((slot, index) => {
            const previous = visibleSlots[index - 1]
            const showNow = Boolean(selectedDate.today) && slot.time >= '08:00' && (previous?.time ?? '00:00') < '08:00'
            return (
              <div key={slot.id}>
                {showNow && <div className="current-time" aria-label="Horário atual: 7 horas e 50 minutos"><span /></div>}
                <div className={`timeline-row${slot.variant === 'completed' ? ' timeline-row--completed' : ''}${slot.variant === 'featured' ? ' timeline-row--current' : ''}`}>
                  <time>{slot.time}</time>
                  {renderSlot(slot)}
                </div>
              </div>
            )
          })}
        </div>

        <aside className="agenda-sidebar" aria-label="Resumo do dia">
          <article><span className="agenda-sidebar__icon"><Icon name="calendar" /></span><div><span>Atendimentos</span><strong>{headingCount} no dia</strong></div></article>
          <article><span className="agenda-sidebar__icon"><Icon name="clock" /></span><div><span>Próximo horário livre</span><strong>{selectedDate.nextFree}</strong></div></article>
          <article><span className="agenda-sidebar__icon"><Icon name="users" /></span><div><span>Ocupação do dia</span><strong>{selectedDate.occupancy}</strong></div></article>
          <div className="agenda-sidebar__legend">
            <h2>Legenda</h2>
            <span><i className="legend-dot legend-dot--confirmed" /> Confirmado</span>
            <span><i className="legend-dot legend-dot--available" /> Com vagas</span>
            <span><i className="legend-dot legend-dot--full" /> Lotado</span>
            <span><i className="legend-dot legend-dot--done" /> Concluído</span>
          </div>
        </aside>
      </div>

      <ScheduleOperations
        visibleFrom={weekDays[0].iso}
        visibleTo={weekDays[weekDays.length - 1].iso}
        preferredDate={selectedDate.iso}
        onAppointments={rememberAppointments}
      />

      {composerOpen && (
        <div className="composer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false) }}>
          <section className="appointment-composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <header><div><span>Novo agendamento</span><h2 id="composer-title">Adicionar à agenda</h2></div><button type="button" aria-label="Fechar" onClick={() => setComposerOpen(false)}>×</button></header>
            <form onSubmit={createAppointment}>
              <label>Cliente<input name="client" defaultValue="Lucas Mendes" required /></label>
              <label>Serviço<select name="service" defaultValue="Avaliação postural"><option>Avaliação postural</option><option>Fisioterapia</option><option>Pilates individual</option></select></label>
              <div className="composer-fields">
                <label>Data<input name="date" type="date" defaultValue={selectedDate.iso} required /></label>
                <label>Horário<input name="time" type="time" defaultValue="10:00" required /></label>
              </div>
              <label>Local<select name="room" defaultValue="Consultório 2"><option>Consultório 2</option><option>Estúdio Principal</option><option>Estúdio Secundário</option></select></label>
              <footer><button type="button" onClick={() => setComposerOpen(false)}>Cancelar</button><button type="submit">Confirmar agendamento</button></footer>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}
