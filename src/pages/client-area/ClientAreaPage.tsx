import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/features/auth'
import {
  bookWithReplacement,
  confirmWaitlistOffer,
  getClientArea,
  getOwnContactChannels,
  getOwnInvoices,
  getOwnAppointments,
  getOwnPublishedClinicalContent,
  getOwnReplacementCredits,
  getOwnWaitlist,
  joinWaitlist,
  leaveWaitlist,
  selfCheckIn,
  type ClientAreaPageId,
  type ClientAreaPayload,
  type ClinicalContentData,
  type OwnClinicalContentPayload,
  type OwnContactChannelsPayload,
  type OwnInvoicesPayload,
  type OwnAppointment,
  type OwnReplacementCreditsPayload,
  type OwnWaitlistPayload,
  type WaitlistAppointment,
} from '@/features/client-area'
import { Button, Card } from '@/shared/ui'
import './ClientAreaPage.css'

const pages: ClientAreaPageId[] = ['client-home', 'my-appointments', 'my-invoices', 'my-content', 'contact', 'my-profile']

const currency = (value: number) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL',
}).format(value / 100)
const invoiceStatus = { open: 'Em aberto', partially_paid: 'Pagamento parcial', overdue: 'Vencida' } as const

function activePageFromHash(): ClientAreaPageId {
  const candidate = window.location.hash.slice(1) as ClientAreaPageId
  return pages.includes(candidate) ? candidate : 'client-home'
}

function formatAppointment(appointment: OwnAppointment | WaitlistAppointment) {
  const timezone = appointment.unit.timezone
  return {
    date: new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone, weekday: 'long', day: '2-digit', month: 'long',
    }).format(new Date(appointment.startsAt)),
    time: new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit',
    }).format(new Date(appointment.startsAt)),
  }
}

function formatWaitlistAppointment(appointment: WaitlistAppointment) {
  return formatAppointment(appointment)
}

function checkInHint(appointment: OwnAppointment) {
  if (appointment.checkedInAt) return 'Check-in realizado'
  if (appointment.checkIn.reason === 'disabled') return 'Check-in pelo aplicativo indisponível'
  if (appointment.checkIn.reason === 'too_early') return 'O check-in abrirá próximo ao horário da sessão'
  if (appointment.checkIn.reason === 'window_closed') return 'Janela de check-in encerrada'
  if (appointment.status === 'cancelled' || appointment.participantStatus === 'cancelled') return 'Cancelado'
  if (appointment.participantStatus === 'attended') return 'Presença registrada'
  if (appointment.participantStatus === 'absent') return 'Falta registrada'
  return 'Agendamento confirmado'
}

function AppointmentCard({ appointment, busy, onCheckIn }: {
  appointment: OwnAppointment
  busy: boolean
  onCheckIn(appointment: OwnAppointment): void
}) {
  const formatted = formatAppointment(appointment)
  return (
    <article className="client-appointment">
      <div className="client-appointment__date"><strong>{formatted.time}</strong><span>{formatted.date}</span></div>
      <div className="client-appointment__details">
        <h3>{appointment.service.name}</h3>
        <p>{appointment.professional.displayName}{appointment.professional.registrationNumber ? ` · Reg.: ${appointment.professional.registrationNumber}` : ''} · {appointment.unit.name}</p>
        <span className={appointment.checkedInAt ? 'client-appointment__status client-appointment__status--done' : 'client-appointment__status'}>{checkInHint(appointment)}</span>
      </div>
      {appointment.checkIn.allowed && (
        <Button disabled={busy} onClick={() => onCheckIn(appointment)}>{busy ? 'Confirmando…' : 'Fazer check-in'}</Button>
      )}
    </article>
  )
}

function ClinicalDetails({ data }: { data: ClinicalContentData }) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return <p>{data === null ? 'Nenhuma orientação adicional foi publicada.' : JSON.stringify(data)}</p>
  }
  const entries = Object.entries(data)
  if (!entries.length) return <p>Nenhuma orientação adicional foi publicada.</p>
  return <dl className="client-clinical-data">{entries.map(([label, value]) => (
    <div key={label}>
      <dt>{label}</dt>
      <dd>{typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)}</dd>
    </div>
  ))}</dl>
}

export function ClientAreaPage() {
  const { session } = useAuth()
  const organizationId = session?.organizationId ?? ''
  const organization = session?.organizations.find(({ id }) => id === organizationId)
  const canReadClinicalContent = organization?.permissions.includes('clinical.published.read') ?? false
  const [activePage, setActivePage] = useState<ClientAreaPageId>(activePageFromHash)
  const [area, setArea] = useState<ClientAreaPayload | null>(null)
  const [appointments, setAppointments] = useState<OwnAppointment[]>([])
  const [waitlist, setWaitlist] = useState<OwnWaitlistPayload>({ entries: [], eligibleAppointments: [] })
  const [replacements, setReplacements] = useState<OwnReplacementCreditsPayload>({
    balance: 0, credits: [], eligibleAppointments: [],
  })
  const [clinicalContent, setClinicalContent] = useState<OwnClinicalContentPayload>({
    assessments: [], workoutPlans: [],
  })
  const [contact, setContact] = useState<OwnContactChannelsPayload>({ channels: [] })
  const [invoices, setInvoices] = useState<OwnInvoicesPayload>({
    items: [], summary: { count: 0, openBalanceCents: 0, overdueBalanceCents: 0 },
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const update = () => setActivePage(activePageFromHash())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      getClientArea(organizationId), getOwnAppointments(organizationId), getOwnWaitlist(organizationId),
      getOwnReplacementCredits(organizationId),
      canReadClinicalContent
        ? getOwnPublishedClinicalContent(organizationId)
        : Promise.resolve({ assessments: [], workoutPlans: [] }),
      getOwnContactChannels(organizationId),
      getOwnInvoices(organizationId),
    ])
      .then(([nextArea, payload, nextWaitlist, nextReplacements, nextClinicalContent, nextContact, nextInvoices]) => {
        if (!active) return
        setArea(nextArea)
        setAppointments(payload.appointments)
        setWaitlist(nextWaitlist)
        setReplacements(nextReplacements)
        setClinicalContent(nextClinicalContent)
        setContact(nextContact)
        setInvoices(nextInvoices)
        setError('')
      })
      .catch((requestError: Error) => active && setError(requestError.message))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [organizationId, canReadClinicalContent])

  const upcoming = useMemo(() => appointments
    .filter((item) => item.status === 'scheduled' && item.participantStatus !== 'cancelled'
      && new Date(item.endsAt).getTime() >= Date.now())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [appointments])
  const past = useMemo(() => appointments.filter((item) => !upcoming.includes(item)), [appointments, upcoming])

  async function checkIn(appointment: OwnAppointment) {
    setBusyId(appointment.id)
    setNotice('')
    try {
      const updated = await selfCheckIn(organizationId, appointment.id)
      setAppointments((current) => current.map((item) => item.id === updated.id ? updated : item))
      setArea((current) => current?.nextAppointment?.id === updated.id
        ? { ...current, nextAppointment: updated } : current)
      setNotice('Check-in realizado. Sua chegada foi registrada.')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Não foi possível realizar o check-in.')
    } finally {
      setBusyId('')
    }
  }

  async function refreshWaitlist() {
    setWaitlist(await getOwnWaitlist(organizationId))
  }

  async function joinInterest(appointmentId: string) {
    setBusyId(appointmentId); setNotice('')
    try {
      await joinWaitlist(organizationId, appointmentId)
      await refreshWaitlist()
      setNotice('Interesse registrado. Você será avisado quando chegar a sua vez.')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Não foi possível registrar o interesse.')
    } finally { setBusyId('') }
  }

  async function leaveInterest(appointmentId: string) {
    setBusyId(appointmentId); setNotice('')
    try {
      await leaveWaitlist(organizationId, appointmentId)
      await refreshWaitlist()
      setNotice('Interesse cancelado.')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Não foi possível cancelar o interesse.')
    } finally { setBusyId('') }
  }

  async function confirmOffer(appointmentId: string) {
    setBusyId(appointmentId); setNotice('')
    try {
      await confirmWaitlistOffer(organizationId, appointmentId)
      const [nextAppointments, nextWaitlist] = await Promise.all([
        getOwnAppointments(organizationId), getOwnWaitlist(organizationId),
      ])
      setAppointments(nextAppointments.appointments)
      setWaitlist(nextWaitlist)
      setNotice('Vaga confirmada. A turma foi adicionada aos seus agendamentos.')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Não foi possível confirmar a vaga.')
    } finally { setBusyId('') }
  }

  async function scheduleReplacement(appointmentId: string) {
    setBusyId(appointmentId); setNotice('')
    try {
      await bookWithReplacement(organizationId, appointmentId)
      const [nextAppointments, nextReplacements] = await Promise.all([
        getOwnAppointments(organizationId), getOwnReplacementCredits(organizationId),
      ])
      setAppointments(nextAppointments.appointments)
      setReplacements(nextReplacements)
      setNotice('Reposição agendada. Um crédito foi utilizado com segurança.')
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Não foi possível agendar a reposição.')
    } finally { setBusyId('') }
  }

  let content
  if (loading) content = <p role="status">Carregando sua área…</p>
  else if (error || !area) content = <Card><div className="card__content"><h1>Não foi possível abrir sua área</h1><p role="alert">{error}</p></div></Card>
  else if (activePage === 'my-content') content = (
    <section className="client-page">
      <header><span>Conteúdo liberado</span><h1>Treinos e avaliações</h1><p>Somente informações publicadas para o seu cadastro aparecem aqui.</p></header>
      {!canReadClinicalContent ? <Card><div className="card__content"><p>O acesso a conteúdo clínico não está habilitado para sua conta.</p></div></Card> : <>
        <h2>Treinos</h2>
        <div className="client-content-list">{clinicalContent.workoutPlans.length ? clinicalContent.workoutPlans.map((workout) => (
          <article className="client-content-card" key={workout.id}>
            <div className="client-content-card__heading"><div><span>Treino</span><h3>{workout.title}</h3></div>{workout.validUntil && <strong>Válido até {new Date(`${workout.validUntil}T12:00:00`).toLocaleDateString('pt-BR')}</strong>}</div>
            <p>Orientado por {workout.professional.displayName}{workout.professional.registrationNumber ? ` (CREFITO/Reg.: ${workout.professional.registrationNumber})` : ''}</p>
            <ClinicalDetails data={workout.instructions} />
          </article>
        )) : <p>Nenhum treino foi liberado para você.</p>}</div>
        <h2>Avaliações</h2>
        <div className="client-content-list">{clinicalContent.assessments.length ? clinicalContent.assessments.map((assessment) => (
          <article className="client-content-card" key={assessment.id}>
            <div className="client-content-card__heading"><div><span>Avaliação</span><h3>{assessment.type}</h3></div><strong>{new Date(assessment.assessedAt).toLocaleDateString('pt-BR')}</strong></div>
            <p>Realizada por {assessment.professional.displayName}{assessment.professional.registrationNumber ? ` (CREFITO/Reg.: ${assessment.professional.registrationNumber})` : ''}</p>
            <ClinicalDetails data={assessment.data} />
          </article>
        )) : <p>Nenhuma avaliação foi liberada para você.</p>}</div>
      </>}
    </section>
  )
  else if (activePage === 'contact') content = (
    <section className="client-page">
      <header><span>Fale com a clínica</span><h1>Contato</h1><p>Escolha um dos canais oficiais disponibilizados pela clínica.</p></header>
      <div className="client-contact-list">{contact.channels.length ? contact.channels.map((channel) => (
        <a className="client-contact-card" href={channel.href} key={channel.id} rel={channel.channel === 'whatsapp' ? 'noreferrer' : undefined} target={channel.channel === 'whatsapp' ? '_blank' : undefined}>
          <span>{channel.channel === 'phone' ? 'Telefone' : channel.channel === 'email' ? 'E-mail' : 'WhatsApp'}</span>
          <strong>{channel.label}</strong>
          <small>{channel.displayValue}</small>
        </a>
      )) : <Card><div className="card__content"><p>A clínica ainda não disponibilizou um canal de contato.</p></div></Card>}</div>
      <p className="client-contact-note">Estes canais pertencem à clínica. Nenhum dado de outros clientes é compartilhado.</p>
    </section>
  )
  else if (activePage === 'my-invoices') content = (
    <section className="client-page">
      <header><span>Seu financeiro</span><h1>Faturas em aberto</h1><p>Valores atualizados a partir dos recebimentos registrados pela clínica.</p></header>
      <div className="client-invoice-summary">
        <Card title="Saldo em aberto"><strong>{currency(invoices.summary.openBalanceCents)}</strong><small>{invoices.summary.count} {invoices.summary.count === 1 ? 'fatura' : 'faturas'}</small></Card>
        <Card title="Saldo vencido"><strong>{currency(invoices.summary.overdueBalanceCents)}</strong><small>{invoices.summary.overdueBalanceCents ? 'Entre em contato com a clínica' : 'Nenhuma pendência vencida'}</small></Card>
      </div>
      <div className="client-invoice-list">{invoices.items.length ? invoices.items.map((invoice) => (
        <article className={`client-invoice${invoice.status === 'overdue' ? ' client-invoice--overdue' : ''}`} key={invoice.id}>
          <div><span>{invoiceStatus[invoice.status]}</span><h2>{invoice.description}</h2><p>Competência {new Date(`${invoice.competenceOn}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p></div>
          <dl><div><dt>Vencimento</dt><dd>{new Date(`${invoice.dueOn}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</dd></div><div><dt>Valor original</dt><dd>{currency(invoice.originalAmountCents)}</dd></div><div><dt>Pago</dt><dd>{currency(invoice.paidAmountCents)}</dd></div><div><dt>Saldo</dt><dd><strong>{currency(invoice.balanceCents)}</strong></dd></div></dl>
        </article>
      )) : <Card><div className="card__content"><p>Você não possui faturas em aberto.</p></div></Card>}</div>
    </section>
  )
  else if (activePage === 'my-profile') content = (
    <section className="client-page">
      <header><span>Seus dados</span><h1>Meu perfil</h1><p>Informações vinculadas à sua conta nesta clínica.</p></header>
      <Card><div className="card__content client-profile">
        <div><span>Nome</span><strong>{area.client.fullName}</strong></div>
        <div><span>Tipo de vínculo</span><strong>{area.client.clientType === 'fixed' ? 'Cliente fixo' : 'Cliente rotativo'}</strong></div>
        {area.activeContract && (
          <div><span>Plano contratado</span><strong>{area.activeContract.name} ({currency(area.activeContract.agreedPriceCents)})</strong></div>
        )}
        {area.client.contacts.map((contact) => <div key={contact.id}><span>{contact.type === 'phone' ? 'Telefone' : contact.type === 'email' ? 'E-mail' : 'Contato'}</span><strong>{contact.value}</strong></div>)}
      </div></Card>
    </section>
  )
  else if (activePage === 'my-appointments') content = (
    <section className="client-page">
      <header><span>Sua rotina</span><h1>Meus agendamentos</h1><p>Acompanhe sessões futuras e seu histórico.</p></header>
      {notice && <p className="client-notice" role="status">{notice}</p>}
      <h2>Próximos</h2>
      <div className="client-appointment-list">{upcoming.length ? upcoming.map((item) => <AppointmentCard key={item.id} appointment={item} busy={busyId === item.id} onCheckIn={checkIn} />) : <p>Nenhum agendamento futuro.</p>}</div>
      <h2>Fila de interesse</h2>
      <div className="client-appointment-list">
        {waitlist.entries.length ? waitlist.entries.map((entry) => {
          const formatted = formatWaitlistAppointment(entry.appointment)
          return <article className="client-appointment client-waitlist" key={entry.id}>
            <div className="client-appointment__date"><strong>{formatted.time}</strong><span>{formatted.date}</span></div>
            <div className="client-appointment__details"><h3>{entry.appointment.service.name}</h3><p>{entry.appointment.professional.displayName} · {entry.appointment.unit.name}</p><span className={`client-appointment__status${entry.status === 'offered' ? ' client-appointment__status--done' : ''}`}>{entry.status === 'offered' ? `Vaga oferecida até ${new Date(entry.offer!.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : `${entry.position}ª posição na fila`}</span></div>
            <div className="client-waitlist__actions">
              {entry.status === 'offered' && <Button disabled={busyId === entry.appointment.id} onClick={() => void confirmOffer(entry.appointment.id)}>{busyId === entry.appointment.id ? 'Confirmando…' : 'Confirmar vaga'}</Button>}
              <Button disabled={busyId === entry.appointment.id} variant="secondary" onClick={() => void leaveInterest(entry.appointment.id)}>{busyId === entry.appointment.id ? 'Aguarde…' : 'Sair da fila'}</Button>
            </div>
          </article>
        }) : <p>Você não está em nenhuma fila.</p>}
      </div>
      {waitlist.eligibleAppointments.length > 0 && <><h2>Turmas lotadas</h2><div className="client-appointment-list">{waitlist.eligibleAppointments.map((item) => { const formatted = formatWaitlistAppointment(item); return <article className="client-appointment client-waitlist" key={item.id}><div className="client-appointment__date"><strong>{formatted.time}</strong><span>{formatted.date}</span></div><div className="client-appointment__details"><h3>{item.service.name}</h3><p>{item.professional.displayName} · {item.unit.name}</p><span className="client-appointment__status">Lotada · {item.occupancy}/{item.capacity}</span></div><Button disabled={busyId === item.id} onClick={() => void joinInterest(item.id)}>{busyId === item.id ? 'Registrando…' : 'Tenho interesse'}</Button></article> })}</div></>}
      <h2>Reposições</h2>
      <div className="client-credit-summary">
        <strong>{replacements.balance}</strong>
        <span>{replacements.balance === 1 ? 'crédito disponível' : 'créditos disponíveis'}</span>
      </div>
      {replacements.eligibleAppointments.length > 0 && <div className="client-appointment-list">{replacements.eligibleAppointments.map((item) => { const formatted = formatWaitlistAppointment(item); return <article className="client-appointment" key={item.id}><div className="client-appointment__date"><strong>{formatted.time}</strong><span>{formatted.date}</span></div><div className="client-appointment__details"><h3>{item.service.name}</h3><p>{item.professional.displayName} · {item.unit.name}</p><span className="client-appointment__status">Vaga disponível · crédito válido</span></div><Button disabled={busyId === item.id} onClick={() => void scheduleReplacement(item.id)}>{busyId === item.id ? 'Agendando…' : 'Usar reposição'}</Button></article> })}</div>}
      {replacements.balance > 0 && replacements.eligibleAppointments.length === 0 && <p>Nenhuma turma disponível dentro da validade dos seus créditos.</p>}
      {past.length > 0 && <><h2>Histórico</h2><div className="client-appointment-list">{past.map((item) => <AppointmentCard key={item.id} appointment={item} busy={false} onCheckIn={checkIn} />)}</div></>}
    </section>
  )
  else content = (
    <section className="client-page client-home">
      <header><span>Área do cliente</span><h1>Olá, {area.client.fullName.split(' ')[0]}!</h1><p>Veja seu próximo compromisso e acesse apenas o que está disponível para você.</p></header>
      {notice && <p className="client-notice" role="status">{notice}</p>}
      <h2>Próximo agendamento</h2>
      {area.nextAppointment ? <AppointmentCard appointment={area.nextAppointment} busy={busyId === area.nextAppointment.id} onCheckIn={checkIn} /> : <Card><div className="card__content"><p>Você não tem agendamentos futuros.</p></div></Card>}
      <div className="client-policy"><strong>Check-in na clínica</strong><span>{area.checkInPolicy.enabled ? `Disponível de ${area.checkInPolicy.beforeMinutes} min antes até ${area.checkInPolicy.afterMinutes} min após o início.` : 'A clínica realiza o check-in presencialmente.'}</span></div>
      <div className="client-credit-summary"><strong>{replacements.balance}</strong><span>{replacements.balance === 1 ? 'reposição disponível' : 'reposições disponíveis'}</span></div>
    </section>
  )

  return content
}
