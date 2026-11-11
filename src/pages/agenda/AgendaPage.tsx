import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/features/auth'
import type { AppointmentRecord } from '@/features/schedule'
import { EmptyState, Icon } from '@/shared/ui'
import { ScheduleOperations } from './ScheduleOperations'
import './AgendaPage.css'

interface AgendaDay {
  weekday: string
  day: number
  iso: string
  fullLabel: string
  today?: boolean
}

type TimelineSlot =
  | { id: string; time: string; variant: 'completed'; title: string }
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
  return formatIso(new Date(value))
}

function localClock(value: string) {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function todayIso() {
  return formatIso(new Date())
}

function buildDay(iso: string, current = todayIso()): AgendaDay {
  const date = parseIso(iso)
  const day = date.getDate()
  const month = monthLong[date.getMonth()]
  return {
    weekday: weekdayShort[date.getDay()],
    day,
    iso,
    fullLabel: `${weekdayLong[date.getDay()]}, ${day} de ${month}`,
    today: iso === current,
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
  if (/lotado/i.test(slot.badge)) return 'full'
  if (/vaga/i.test(slot.badge)) return 'available'
  return 'confirmed'
}

function badgeClass(mark: AttendanceMark) {
  if (mark === 'full') return 'capacity-badge capacity-badge--full'
  if (mark === 'available') return 'capacity-badge capacity-badge--available'
  return 'capacity-badge'
}

function slotFromRecord(item: AppointmentRecord): TimelineSlot {
  const time = localClock(item.startsAt)
  if (item.status === 'completed') {
    return { id: item.id, time, variant: 'completed', title: item.service.name }
  }
  const place = item.room?.name ?? item.unit.name
  const full = item.appointmentType === 'class' && item.occupancy >= item.capacity
  const openSeats = Math.max(item.capacity - item.occupancy, 0)
  const badge = item.appointmentType === 'class'
    ? (full ? `Lotado (${item.occupancy}/${item.capacity})` : `${openSeats} ${openSeats === 1 ? 'vaga' : 'vagas'}`)
    : 'Confirmado'
  const names = item.appointmentType === 'class'
    ? item.participants.filter((participant) => participant.status !== 'cancelled').map((participant) => participant.client.fullName)
    : [item.client?.fullName].filter((name): name is string => Boolean(name))
  const waiting = item.waitlist.filter((entry) => entry.status === 'queued' || entry.status === 'offered').length
  return {
    id: item.id,
    time,
    variant: 'client',
    title: item.service.name,
    place: `${place} · ${item.service.durationMinutes} min`,
    badge,
    client: names.join(', ') || 'Sem cliente vinculado',
    initials: initials(names[0] ?? 'AG'),
    note: waiting > 0 ? `${waiting} na fila` : item.professional.displayName,
  }
}

function slotsFor(day: AgendaDay, operational: AppointmentRecord[]) {
  return operational
    .filter((item) => item.status !== 'cancelled' && localDay(item.startsAt) === day.iso)
    .map(slotFromRecord)
    .sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id))
}

interface AgendaPageProps {
  openComposerRequest?: number
}

export function AgendaPage({ openComposerRequest = 0 }: AgendaPageProps) {
  const { session } = useAuth()
  const organization = session?.organizations.find((item) => item.id === session.organizationId)
  const currentDay = todayIso()
  const [weekMonday, setWeekMonday] = useState(() => mondayOf(currentDay))
  const [selectedIso, setSelectedIso] = useState(currentDay)
  const [composeRequest, setComposeRequest] = useState(openComposerRequest)
  const [operationalAppointments, setOperationalAppointments] = useState<AppointmentRecord[]>([])
  const weekDays = weekOf(weekMonday)
  const selectedDate = weekDays.find((date) => date.iso === selectedIso) ?? buildDay(selectedIso)
  const visibleSlots = slotsFor(selectedDate, operationalAppointments)
  const rememberAppointments = useCallback((items: AppointmentRecord[]) => {
    setOperationalAppointments(items)
  }, [])

  useEffect(() => {
    if (openComposerRequest > 0) setComposeRequest(openComposerRequest)
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

  function openRealComposer() {
    setComposeRequest((current) => current + 1)
    document.getElementById('schedule-operations-title')?.scrollIntoView({ block: 'start' })
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

  const headingCount = visibleSlots.length

  return (
    <section className="agenda-page" aria-labelledby="agenda-title">
      <header className="page-heading agenda-heading">
        <div>
          <p className="page-heading__eyebrow">{organization?.name ?? 'Agenda'}</p>
          <h1 id="agenda-title">Agenda</h1>
          <p>{selectedDate.fullLabel} · {headingCount === 1 ? '1 atendimento' : `${headingCount} atendimentos`}</p>
        </div>
        <button className="agenda-heading__action" type="button" onClick={openRealComposer}>
          <Icon name="plus" /> Novo agendamento
        </button>
      </header>

      <div className="agenda-toolbar">
        <div className="agenda-toolbar__month">
          <button type="button" aria-label="Semana anterior" onClick={() => shiftWeek(-1)}><Icon name="chevron-left" /></button>
          <strong>{weekTitle(weekDays)}</strong>
          <button type="button" aria-label="Próxima semana" onClick={() => shiftWeek(1)}><Icon name="chevron-right" /></button>
        </div>
        <button className="agenda-toolbar__today" type="button" onClick={() => showDate(currentDay)}>Hoje</button>
      </div>

      <div className="date-picker" aria-label="Selecionar dia">
        {weekDays.map((date) => {
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

      <div className="agenda-layout">
        <div className="agenda-timeline" aria-label={`Horários de ${selectedDate.fullLabel}`}>
          {visibleSlots.length === 0 ? (
            <EmptyState title="Nenhum atendimento neste dia" description="Os horários cadastrados para esta data aparecem aqui." />
          ) : visibleSlots.map((slot) => (
            <div key={slot.id} className={`timeline-row${slot.variant === 'completed' ? ' timeline-row--completed' : ''}`}>
              <time>{slot.time}</time>
              {renderSlot(slot)}
            </div>
          ))}
        </div>

        <aside className="agenda-sidebar" aria-label="Resumo do dia">
          <article><span className="agenda-sidebar__icon"><Icon name="calendar" /></span><div><span>Atendimentos</span><strong>{headingCount} no dia</strong></div></article>
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
        composeRequest={composeRequest}
        onAppointments={rememberAppointments}
      />
    </section>
  )
}
