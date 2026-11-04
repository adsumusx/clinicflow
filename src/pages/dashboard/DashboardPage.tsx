import { Icon } from '@/shared/ui'
import './DashboardPage.css'

const revenue = [
  { day: 'Seg', height: 40, value: 'R$ 400' },
  { day: 'Ter', height: 65, value: 'R$ 650' },
  { day: 'Qua', height: 80, value: 'R$ 800' },
  { day: 'Qui', height: 100, value: 'R$ 1.000', current: true },
  { day: 'Sex', height: 50, value: 'R$ 500' },
]

const appointments = [
  { time: '08:00', title: 'Pilates em Grupo', detail: '4 alunos · Estúdio Principal', tone: 'full', badge: 'Lotado' },
  { time: '09:00', title: 'Sessão Funcional', detail: 'Carlos Eduardo · Estúdio 2', tone: 'available', badge: '2 vagas' },
  { time: '11:30', title: 'Fisioterapia', detail: 'Marina Souza · Consultório 1', tone: 'confirmed', badge: 'Confirmado' },
]

interface DashboardPageProps {
  onCreateAppointment: () => void
}

export function DashboardPage({ onCreateAppointment }: DashboardPageProps) {
  return (
    <section className="dashboard-page" aria-labelledby="dashboard-title">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">Terça-feira, 1 de setembro</p>
          <h1 id="dashboard-title">Olá, Ana!</h1>
          <p>Veja o que está acontecendo hoje na Clínica Serena.</p>
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
            <p><strong>12</strong> <span>agendadas</span></p>
          </div>
          <span className="summary-card__icon"><Icon name="calendar" /></span>
        </article>

        <article className="summary-card summary-card--pending">
          <div className="summary-card__heading"><Icon name="alert" /><span>Pendentes</span></div>
          <p><strong>3</strong><span>R$ 450,00</span></p>
        </article>

        <article className="summary-card summary-card--leads">
          <div className="summary-card__heading"><Icon name="user-plus" /><span>Novos leads</span></div>
          <p><strong>5</strong><span>esta semana</span></p>
        </article>
      </div>

      <div className="quick-actions" aria-label="Ações rápidas">
        <button className="quick-action quick-action--primary" type="button" onClick={onCreateAppointment}>
          <Icon name="plus" /> Nova consulta
        </button>
        <button className="quick-action quick-action--secondary" type="button">
          <Icon name="user-plus" /> Novo cliente
        </button>
      </div>

      <div className="dashboard-grid">
        <article className="dashboard-panel schedule-preview">
          <header className="panel-heading">
            <div><span>Agenda do dia</span><h2>Próximos atendimentos</h2></div>
            <a href="#agenda">Ver agenda completa <Icon name="arrow-right" /></a>
          </header>
          <ol className="schedule-preview__list">
            {appointments.map((appointment) => (
              <li key={appointment.time}>
                <time>{appointment.time}</time>
                <span className={`schedule-preview__marker schedule-preview__marker--${appointment.tone}`} />
                <div><strong>{appointment.title}</strong><span>{appointment.detail}</span></div>
                <span className={`appointment-badge appointment-badge--${appointment.tone}`}>{appointment.badge}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="dashboard-panel revenue-panel">
          <header className="panel-heading panel-heading--revenue">
            <div><span>Receita da semana</span><h2>R$ 4.250,00</h2></div>
            <span className="revenue-trend"><Icon name="trend-up" /> +12%</span>
          </header>
          <div className="revenue-chart" aria-label="Receita de segunda a sexta-feira">
            {revenue.map((item) => (
              <div className={`revenue-chart__item${item.current ? ' revenue-chart__item--current' : ''}`} key={item.day}>
                <span className="revenue-chart__value">{item.value}</span>
                <span className="revenue-chart__bar" style={{ height: `${item.height}%` }} />
                <span className="revenue-chart__day">{item.day}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="birthday-card">
          <div>
            <span className="birthday-card__label"><Icon name="cake" /> Aniversariante do dia</span>
            <h2>Mariana Silva</h2>
            <button type="button">Enviar mensagem <Icon name="arrow-right" /></button>
          </div>
          <div className="birthday-card__confetti" aria-hidden="true"><i /><i /><i /><i /></div>
        </article>
      </div>
    </section>
  )
}
