import { useEffect, useState } from 'react'
import { useAuth } from '@/features/auth'
import { listReceivables } from '@/features/finance'
import { listProspects } from '@/features/leads'
import { getBusinessDashboardReport, listBirthdayReport, type BirthdayReportItem } from '@/features/reports'
import { getSchedule, type AppointmentRecord } from '@/features/schedule'
import { EmptyState, Icon } from '@/shared/ui'
import './DashboardPage.css'

interface DashboardPageProps {
  onCreateAppointment: () => void
}

interface DashboardSnapshot {
  appointments: AppointmentRecord[]
  birthdays: BirthdayReportItem[]
  leadsThisWeek: number
  pendingBalanceCents: number
  pendingCount: number
  receivedCents: number
}

const emptySnapshot: DashboardSnapshot = {
  appointments: [],
  birthdays: [],
  leadsThisWeek: 0,
  pendingBalanceCents: 0,
  pendingCount: 0,
  receivedCents: 0,
}

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfWeek(date: Date) {
  const copy = new Date(date)
  const weekday = copy.getDay()
  copy.setDate(copy.getDate() + (weekday === 0 ? -6 : 1 - weekday))
  copy.setHours(0, 0, 0, 0)
  return copy
}

function money(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function clock(value: string) {
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function appointmentTone(appointment: AppointmentRecord) {
  if (appointment.capacity > 0 && appointment.occupancy >= appointment.capacity) return 'full'
  return 'available'
}

function appointmentBadge(appointment: AppointmentRecord) {
  if (appointment.capacity > 1) {
    const open = Math.max(appointment.capacity - appointment.occupancy, 0)
    return open === 0 ? 'Lotado' : `${open} ${open === 1 ? 'vaga' : 'vagas'}`
  }
  const participant = appointment.participants.find((item) => item.status !== 'cancelled')
  if (participant?.status === 'confirmed') return 'Confirmado'
  if (participant?.status === 'attended') return 'Compareceu'
  return 'Agendado'
}

function appointmentDetail(appointment: AppointmentRecord) {
  const names = appointment.participants
    .filter((item) => item.status !== 'cancelled')
    .map((item) => item.client.fullName)
  const place = [appointment.room?.name, appointment.professional.displayName].filter(Boolean)
  return [names.join(', ') || 'Sem cliente vinculado', ...place].join(' · ')
}

export function DashboardPage({ onCreateAppointment }: DashboardPageProps) {
  const { session } = useAuth()
  const organization = session?.organizations.find((item) => item.id === session.organizationId)
  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot)
  const today = new Date()
  const todayLabel = today.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  const headingDate = todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1)

  useEffect(() => {
    const organizationId = session?.organizationId
    if (!organizationId) return
    let active = true
    const dayStart = new Date(today)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(today)
    dayEnd.setHours(23, 59, 59, 999)
    const weekStart = startOfWeek(today)
    const todayIso = isoDate(today)
    const weekIso = isoDate(weekStart)

    setLoading(true)
    Promise.allSettled([
      getSchedule(organizationId, dayStart.toISOString(), dayEnd.toISOString()),
      listReceivables(organizationId),
      listProspects(organizationId, { pageSize: 100 }),
      listBirthdayReport(organizationId, { from: todayIso, to: todayIso }),
      getBusinessDashboardReport(organizationId, { from: weekIso, to: todayIso }),
    ]).then(([schedule, receivables, prospects, birthdays, business]) => {
      if (!active) return
      const appointments = schedule.status === 'fulfilled' && Array.isArray(schedule.value.appointments)
        ? schedule.value.appointments
          .filter((item) => item.status !== 'cancelled')
          .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
        : []
      const pending = receivables.status === 'fulfilled' ? receivables.value.summary : undefined
      const prospectItems = prospects.status === 'fulfilled' && Array.isArray(prospects.value.items)
        ? prospects.value.items
        : []
      const birthdayItems = birthdays.status === 'fulfilled' && Array.isArray(birthdays.value.items)
        ? birthdays.value.items
        : []
      const received = business.status === 'fulfilled' ? business.value.financial?.receivedCents ?? 0 : 0
      setSnapshot({
        appointments,
        birthdays: birthdayItems,
        leadsThisWeek: prospectItems.filter((item) => item.createdAt >= weekStart.toISOString()).length,
        pendingBalanceCents: (pending?.openBalanceCents ?? 0) + (pending?.overdueBalanceCents ?? 0),
        pendingCount: pending?.count ?? 0,
        receivedCents: received,
      })
      setLoading(false)
    })

    return () => { active = false }
  }, [session?.organizationId])

  return (
    <section className="dashboard-page" aria-labelledby="dashboard-title">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">{headingDate}</p>
          <h1 id="dashboard-title">{organization?.name ?? 'Clínica'}</h1>
          <p>Resumo do que está cadastrado hoje.</p>
        </div>
        <button className="dashboard-heading-action" type="button" onClick={onCreateAppointment}>
          <Icon name="plus" />
          Nova consulta
        </button>
      </header>

      <div className="dashboard-summary" aria-label="Indicadores do dia">
        <article className="summary-card summary-card--appointments">
          <div>
            <span className="summary-card__label">Consultas hoje</span>
            <p><strong>{loading ? '—' : snapshot.appointments.length}</strong> <span>agendadas</span></p>
          </div>
          <span className="summary-card__icon"><Icon name="calendar" /></span>
        </article>

        <article className="summary-card summary-card--pending">
          <div className="summary-card__heading"><Icon name="alert" /><span>Pendentes</span></div>
          <p><strong>{loading ? '—' : snapshot.pendingCount}</strong><span>{loading ? '' : money(snapshot.pendingBalanceCents)}</span></p>
        </article>

        <article className="summary-card summary-card--leads">
          <div className="summary-card__heading"><Icon name="user-plus" /><span>Novos leads</span></div>
          <p><strong>{loading ? '—' : snapshot.leadsThisWeek}</strong><span>esta semana</span></p>
        </article>
      </div>

      <div className="quick-actions" aria-label="Ações rápidas">
        <button className="quick-action quick-action--primary" type="button" onClick={onCreateAppointment}>
          <Icon name="plus" /> Nova consulta
        </button>
        <a className="quick-action quick-action--secondary" href="#clients">
          <Icon name="user-plus" /> Novo cliente
        </a>
      </div>

      <div className="dashboard-grid">
        <article className="dashboard-panel schedule-preview">
          <header className="panel-heading">
            <div><span>Agenda do dia</span><h2>Próximos atendimentos</h2></div>
            <a href="#agenda">Ver agenda completa <Icon name="arrow-right" /></a>
          </header>
          {snapshot.appointments.length === 0 ? (
            <EmptyState compact title="Nenhum atendimento hoje" description="Os horários cadastrados na agenda aparecem aqui." />
          ) : (
            <ol className="schedule-preview__list">
              {snapshot.appointments.map((appointment) => {
                const tone = appointmentTone(appointment)
                return (
                  <li key={appointment.id}>
                    <time>{clock(appointment.startsAt)}</time>
                    <span className={`schedule-preview__marker schedule-preview__marker--${tone}`} />
                    <div><strong>{appointment.service.name}</strong><span>{appointmentDetail(appointment)}</span></div>
                    <span className={`appointment-badge appointment-badge--${tone}`}>{appointmentBadge(appointment)}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </article>

        <article className="dashboard-panel revenue-panel">
          <header className="panel-heading panel-heading--revenue">
            <div><span>Receita da semana</span><h2>{loading ? '—' : money(snapshot.receivedCents)}</h2></div>
          </header>
          {snapshot.receivedCents === 0 ? (
            <EmptyState compact title="Nenhum recebimento nesta semana" description="Os pagamentos lançados no financeiro entram neste total." />
          ) : (
            <p className="dashboard-note">Total recebido de segunda até hoje.</p>
          )}
        </article>

        <article className="birthday-card">
          <div>
            <span className="birthday-card__label"><Icon name="cake" /> Aniversariante do dia</span>
            {snapshot.birthdays.length === 0 ? (
              <h2>Nenhum aniversariante hoje</h2>
            ) : snapshot.birthdays.map((birthday) => (
              <h2 key={birthday.clientId}>{birthday.fullName}</h2>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}
