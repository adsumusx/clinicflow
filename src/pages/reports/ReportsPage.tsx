import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '@/features/auth'
import {
  downloadBirthdayReport, downloadBusinessDashboardReport, downloadClientActivityReport,
  downloadClientReport, downloadEquipmentUsageReport, downloadProspectReport,
  getBusinessDashboardReport, getReportFilters,
  listBirthdayReport, listClientActivityReport, listClientReport, listEquipmentUsageReport,
  listProspectReport,
  type ActivityGranularity, type BirthdayReportResponse, type ClientActivityReportResponse,
  type BusinessDashboardReportResponse, type ClientReportResponse, type ClientReportType,
  type EquipmentUsageReportResponse, type ProspectReportResponse, type ProspectStage,
  type ReportFilters, type ReportFiltersCatalog,
} from '@/features/reports'
import { Button, Card, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/shared/ui'
import './ReportsPage.css'

type ReportKind = 'birthdays' | 'clients' | 'activity' | 'dashboard' | 'equipment' | 'prospects'

function defaultPeriod(): ReportFilters {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const localDate = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  return { from: localDate(from), to: localDate(to) }
}

const birthdayDateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' })
const dateFormatter = new Intl.DateTimeFormat('pt-BR')
const monthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const asLocalDate = (date: string) => new Date(`${date}T12:00:00`)

function saveExport(exported: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(exported.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = exported.filename
  link.click()
  URL.revokeObjectURL(url)
}

export function ReportsPage() {
  const { session } = useAuth()
  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const organizationId = organization?.id
  const canRead = organization?.permissions.includes('reports.read') ?? false
  const [catalog, setCatalog] = useState<ReportFiltersCatalog>({ units: [], professionals: [], modalities: [], statuses: [] })
  const [kind, setKind] = useState<ReportKind>('birthdays')
  const [clientType, setClientType] = useState<ClientReportType>('all')
  const [granularity, setGranularity] = useState<ActivityGranularity>('month')
  const [modalityId, setModalityId] = useState('')
  const [filters, setFilters] = useState<ReportFilters>(defaultPeriod)
  const [birthdayReport, setBirthdayReport] = useState<BirthdayReportResponse | null>(null)
  const [clientReport, setClientReport] = useState<ClientReportResponse | null>(null)
  const [activityReport, setActivityReport] = useState<ClientActivityReportResponse | null>(null)
  const [dashboardReport, setDashboardReport] = useState<BusinessDashboardReportResponse | null>(null)
  const [equipmentReport, setEquipmentReport] = useState<EquipmentUsageReportResponse | null>(null)
  const [prospectReport, setProspectReport] = useState<ProspectReportResponse | null>(null)
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (reportKind: ReportKind, nextFilters: ReportFilters, page = 1, options: { clientType?: ClientReportType; granularity?: ActivityGranularity; bucket?: string; modalityId?: string } = {}) => {
    if (!organizationId || !canRead) return
    setLoading(true)
    setError('')
    try {
      if (reportKind === 'birthdays') {
        setBirthdayReport(await listBirthdayReport(organizationId, nextFilters, page))
      } else if (reportKind === 'clients') {
        setClientReport(await listClientReport(organizationId, nextFilters, options.clientType ?? clientType, page))
      } else if (reportKind === 'activity') {
        const bucket = options.bucket
        setActivityReport(await listClientActivityReport(organizationId, nextFilters, options.granularity ?? granularity, bucket, page))
        setSelectedBucket(bucket ?? null)
      } else if (reportKind === 'dashboard') {
        setDashboardReport(await getBusinessDashboardReport(organizationId, nextFilters))
      } else if (reportKind === 'equipment') {
        const nextModalityId = Object.hasOwn(options, 'modalityId') ? options.modalityId ?? '' : modalityId
        setEquipmentReport(await listEquipmentUsageReport(
          organizationId, nextFilters, nextModalityId || undefined, page,
        ))
      } else {
        setProspectReport(await listProspectReport(organizationId, nextFilters, page))
      }
      setFilters(nextFilters)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o relatório.')
    } finally {
      setLoading(false)
    }
  }, [canRead, clientType, granularity, modalityId, organizationId])

  useEffect(() => {
    if (!organizationId || !canRead) { setLoading(false); return }
    const initial = defaultPeriod()
    let active = true
    setLoading(true)
    Promise.all([getReportFilters(organizationId), listBirthdayReport(organizationId, initial)])
      .then(([nextCatalog, nextReport]) => {
        if (!active) return
        setCatalog(nextCatalog); setFilters(initial); setBirthdayReport(nextReport); setError('')
      })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o relatório.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [canRead, organizationId])

  function changeKind(nextKind: ReportKind) {
    setKind(nextKind); setSelectedBucket(null); void load(nextKind, filters)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const nextFilters: ReportFilters = { from: String(data.get('from') ?? ''), to: String(data.get('to') ?? '') }
    const unitId = String(data.get('unitId') ?? '')
    const professionalId = String(data.get('professionalId') ?? '')
    const status = String(data.get('status') ?? '')
    if (unitId) nextFilters.unitId = unitId
    if (professionalId) nextFilters.professionalId = professionalId
    if (status === 'active' || status === 'inactive') nextFilters.status = status
    setSelectedBucket(null); void load(kind, nextFilters)
  }

  async function exportCsv() {
    if (!organizationId) return
    setExporting(true); setError('')
    try {
      if (kind === 'birthdays') saveExport(await downloadBirthdayReport(organizationId, filters))
      else if (kind === 'clients') saveExport(await downloadClientReport(organizationId, filters, clientType))
      else if (kind === 'activity') saveExport(await downloadClientActivityReport(organizationId, filters, granularity, selectedBucket ?? undefined))
      else if (kind === 'dashboard') saveExport(await downloadBusinessDashboardReport(organizationId, filters))
      else if (kind === 'equipment') saveExport(await downloadEquipmentUsageReport(organizationId, filters, modalityId || undefined))
      else saveExport(await downloadProspectReport(organizationId, filters))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível exportar o relatório.')
    } finally { setExporting(false) }
  }

  if (!canRead) return <EmptyState title="Relatórios indisponíveis" description="Seu perfil não possui permissão para consultar relatórios." />

  const hasRows = kind === 'birthdays' ? Boolean(birthdayReport?.items.length)
    : kind === 'clients' ? Boolean(clientReport?.items.length)
      : kind === 'activity' ? (selectedBucket ? Boolean(activityReport?.details.length) : Boolean(activityReport?.items.length))
        : kind === 'dashboard' ? Boolean(dashboardReport)
          : kind === 'equipment' ? Boolean(equipmentReport?.items.length)
            : Boolean(prospectReport?.items.length)
  const title = kind === 'birthdays' ? 'Aniversariantes'
    : kind === 'clients' ? 'Clientes'
      : kind === 'activity' ? 'Atividade de clientes'
        : kind === 'dashboard' ? 'Dashboard de negócio'
          : kind === 'equipment' ? 'Aparelhos utilizados'
            : 'Prospecções'

  return <section className="reports-page">
    <header className="reports-page__header"><div><span>Relatórios</span><h1>{title}</h1><p>Consulte o período e exporte exatamente a mesma seleção.</p></div><Button variant="secondary" disabled={loading || !hasRows} loading={exporting} onClick={() => void exportCsv()}>Exportar CSV</Button></header>
    <nav className="report-tabs" aria-label="Tipos de relatório">
      <button aria-current={kind === 'birthdays' ? 'page' : undefined} onClick={() => changeKind('birthdays')}>Aniversariantes</button>
      <button aria-current={kind === 'clients' ? 'page' : undefined} onClick={() => changeKind('clients')}>Clientes e planos</button>
      <button aria-current={kind === 'activity' ? 'page' : undefined} onClick={() => changeKind('activity')}>Atividade mês/ano</button>
      <button aria-current={kind === 'dashboard' ? 'page' : undefined} onClick={() => changeKind('dashboard')}>Dashboard de negócio</button>
      <button aria-current={kind === 'equipment' ? 'page' : undefined} onClick={() => changeKind('equipment')}>Aparelhos utilizados</button>
      <button aria-current={kind === 'prospects' ? 'page' : undefined} onClick={() => changeKind('prospects')}>Prospecções</button>
    </nav>
    <Card title="Filtros do relatório"><form className="report-filters" onSubmit={submit}>
      <label>De<input name="from" type="date" required defaultValue={filters.from} /></label>
      <label>Até<input name="to" type="date" required defaultValue={filters.to} /></label>
      <label>Unidade<select name="unitId" defaultValue={filters.unitId ?? ''}><option value="">Todas</option>{catalog.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
      <label>Profissional<select name="professionalId" defaultValue={filters.professionalId ?? ''}><option value="">Todos</option>{catalog.professionals.map((professional) => <option key={professional.id} value={professional.id}>{professional.displayName}</option>)}</select></label>
      <label>Situação<select name="status" defaultValue={filters.status ?? ''}><option value="">Todas</option>{catalog.statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
      {kind === 'clients' && <label>Visão<select aria-label="Visão de clientes" value={clientType} onChange={(event) => { const value = event.target.value as ClientReportType; setClientType(value); void load(kind, filters, 1, { clientType: value }) }}><option value="all">Geral</option><option value="fixed">Planos fixos</option></select></label>}
      {kind === 'activity' && <label>Agrupar por<select aria-label="Agrupar por" value={granularity} onChange={(event) => { const value = event.target.value as ActivityGranularity; setGranularity(value); setSelectedBucket(null); void load(kind, filters, 1, { granularity: value }) }}><option value="month">Mês</option><option value="year">Ano</option></select></label>}
      {kind === 'equipment' && <label>Modalidade<select aria-label="Modalidade" value={modalityId} onChange={(event) => { const value = event.target.value; setModalityId(value); void load(kind, filters, 1, { modalityId: value }) }}><option value="">Todas</option>{catalog.modalities.map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}</select></label>}
      <Button type="submit" loading={loading}>Aplicar filtros</Button>
    </form></Card>
    {error && <ErrorState title="Não foi possível carregar" description={error} action={<Button onClick={() => void load(kind, filters, 1, { bucket: selectedBucket ?? undefined, modalityId })}>Tentar novamente</Button>} />}
    {!error && loading && <LoadingState title={`Carregando ${title.toLocaleLowerCase('pt-BR')}`} description="Aplicando os filtros selecionados…" />}
    {!error && !loading && kind === 'birthdays' && <BirthdayResult report={birthdayReport} loadPage={(page) => load('birthdays', filters, page)} />}
    {!error && !loading && kind === 'clients' && <ClientResult report={clientReport} loadPage={(page) => load('clients', filters, page)} />}
    {!error && !loading && kind === 'activity' && <ActivityResult report={activityReport} selectedBucket={selectedBucket} granularity={granularity} openBucket={(bucket, page = 1) => load('activity', filters, page, { bucket })} closeBucket={() => load('activity', filters, 1, { granularity })} />}
    {!error && !loading && kind === 'dashboard' && <BusinessDashboardResult report={dashboardReport} />}
    {!error && !loading && kind === 'equipment' && <EquipmentUsageResult report={equipmentReport} loadPage={(page) => load('equipment', filters, page, { modalityId })} />}
    {!error && !loading && kind === 'prospects' && <ProspectResult report={prospectReport} loadPage={(page) => load('prospects', filters, page)} />}
  </section>
}

function BusinessDashboardResult({ report }: { report: BusinessDashboardReportResponse | null }) {
  if (!report) return <EmptyState title="Dashboard indisponível" description="Não foi possível obter os indicadores do período." />
  const money = (cents: number) => currencyFormatter.format(cents / 100)
  return <><div className="report-metrics report-metrics--dashboard" aria-label="Indicadores financeiros conciliados"><Card title="Faturado"><strong>{money(report.financial.billedCents)}</strong><small>pela competência no período</small></Card><Card title="Recebido líquido"><strong>{money(report.financial.receivedCents)}</strong><small>pagamentos menos estornos</small></Card><Card title="Saldo em aberto"><strong>{money(report.financial.outstandingCents)}</strong><small>vencimentos do período</small></Card></div><div className="report-metrics report-metrics--dashboard" aria-label="Indicadores operacionais conciliados"><Card title="Agendamentos"><strong>{report.operational.appointments}</strong></Card><Card title="Realizados"><strong>{report.operational.completedAppointments}</strong></Card><Card title="Presenças"><strong>{report.operational.attendances}</strong></Card><Card title="Faltas"><strong>{report.operational.absences}</strong></Card><Card title="Taxa de presença"><strong>{report.operational.attendanceRate.toLocaleString('pt-BR')}%</strong><small>entre presenças e faltas</small></Card></div><p className="report-rule">Valores financeiros vêm dos lançamentos conciliados; estornos reduzem o recebido. Operação considera a data local da unidade.</p></>
}

function EquipmentUsageResult({ report, loadPage }: { report: EquipmentUsageReportResponse | null; loadPage: (page: number) => void }) {
  if (!report?.items.length) return <EmptyState title="Nenhum aparelho utilizado" description="Não há agendamentos concluídos com presença e aparelho no período selecionado." />
  return <><div className="report-metrics" aria-label="Totais de utilização de aparelhos"><Card title="Tipos utilizados"><strong>{report.totals.equipmentTypes}</strong></Card><Card title="Agendamentos realizados"><strong>{report.totals.appointments}</strong></Card><Card title="Quantidade alocada"><strong>{report.totals.allocatedQuantity}</strong></Card></div><Card title={`${report.pagination.total} combinação${report.pagination.total === 1 ? '' : 'ões'} de aparelho e modalidade`}><p className="report-rule">Conta somente agendamentos concluídos com ao menos uma presença registrada.</p><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Aparelho</th><th>Modalidade</th><th>Unidade</th><th>Agendamentos</th><th>Quantidade alocada</th><th>Presenças</th><th>Último uso</th></tr></thead><tbody>{report.items.map((item) => <tr key={`${item.equipmentId}-${item.modalityId}`}><td><strong>{item.equipmentName}</strong><small>{item.availableQuantity} disponível{item.availableQuantity === 1 ? '' : 'is'}</small></td><td>{item.modalityName}</td><td>{item.unitName}</td><td>{item.appointments}</td><td>{item.allocatedQuantity}</td><td>{item.attendances}</td><td>{dateFormatter.format(asLocalDate(item.lastUsedOn))}</td></tr>)}</tbody></table></div><Pagination pagination={report.pagination} onPage={loadPage} /></Card></>
}

const prospectStageLabels: Record<ProspectStage, string> = {
  new: 'Nova',
  contacted: 'Contatada',
  qualified: 'Qualificada',
  proposal: 'Proposta',
  lost: 'Perdida',
  converted: 'Convertida',
}

function ProspectResult({ report, loadPage }: { report: ProspectReportResponse | null; loadPage: (page: number) => void }) {
  if (!report?.items.length) return <EmptyState title="Nenhuma prospecção" description="Não há prospecções cadastradas no período e nos filtros selecionados." />
  return <><div className="report-metrics report-metrics--prospects" aria-label="Indicadores do funil de prospecções"><Card title="Prospecções"><strong>{report.totals.total}</strong><small>{report.totals.open} em andamento</small></Card><Card title="Conversões"><strong>{report.totals.converted}</strong><small>{report.totals.conversionRate.toLocaleString('pt-BR')}% da base</small></Card><Card title="Perdas"><strong>{report.totals.lost}</strong><small>{report.totals.lossRate.toLocaleString('pt-BR')}% da base</small></Card><Card title="Tempo médio de ciclo"><strong>{report.totals.averageCycleDays.toLocaleString('pt-BR')} dias</strong><small>até conversão ou perda</small></Card></div><div className="report-breakdowns"><Card title="Etapas atuais"><div className="report-stage-list">{(Object.entries(prospectStageLabels) as Array<[ProspectStage, string]>).map(([stage, label]) => <div key={stage}><span>{label}</span><strong>{report.stages[stage]}</strong></div>)}</div></Card><Card title="Desempenho por origem"><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Origem</th><th>Total</th><th>Conversões</th><th>Perdas</th><th>Taxa de conversão</th></tr></thead><tbody>{report.sources.map((source) => <tr key={source.source}><td>{source.source}</td><td>{source.total}</td><td>{source.converted}</td><td>{source.lost}</td><td>{source.conversionRate.toLocaleString('pt-BR')}%</td></tr>)}</tbody></table></div></Card></div><Card title={`${report.pagination.total} ${report.pagination.total === 1 ? 'prospecção' : 'prospecções'}`}><p className="report-rule">A base considera cadastros no período. O ciclo termina na conversão ou na entrada na etapa perdida.</p><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Cadastro</th><th>Prospecção</th><th>Origem</th><th>Etapa</th><th>Responsável</th><th>Desfecho</th><th>Ciclo</th></tr></thead><tbody>{report.items.map((item) => <tr key={item.prospectId}><td>{dateFormatter.format(asLocalDate(item.createdOn))}</td><td><strong>{item.fullName}</strong></td><td>{item.source}</td><td><StatusBadge tone={item.stage === 'converted' ? 'success' : item.stage === 'lost' ? 'warning' : 'neutral'}>{prospectStageLabels[item.stage]}</StatusBadge></td><td>{item.ownerDisplayName ?? 'Sem responsável'}</td><td>{item.closedOn ? dateFormatter.format(asLocalDate(item.closedOn)) : 'Em andamento'}</td><td>{item.cycleDays === null ? '—' : `${item.cycleDays.toLocaleString('pt-BR')} dias`}</td></tr>)}</tbody></table></div><Pagination pagination={report.pagination} onPage={loadPage} /></Card></>
}

function Pagination({ pagination, onPage }: { pagination: NonNullable<ClientActivityReportResponse['pagination']>; onPage: (page: number) => void }) {
  if (pagination.totalPages <= 1) return null
  return <nav className="report-pagination" aria-label="Paginação do relatório"><Button variant="secondary" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>Anterior</Button><span>Página {pagination.page} de {pagination.totalPages}</span><Button variant="secondary" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>Próxima</Button></nav>
}

function BirthdayResult({ report, loadPage }: { report: BirthdayReportResponse | null; loadPage: (page: number) => void }) {
  if (!report?.items.length) return <EmptyState title="Nenhum aniversariante" description="Nenhum cliente faz aniversário neste período. A data de nascimento fica no perfil do cliente." />
  return <Card title={`${report.pagination.total} aniversariante${report.pagination.total === 1 ? '' : 's'}`}><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Data</th><th>Cliente</th><th>Situação</th><th>Contato preferencial</th></tr></thead><tbody>{report.items.map((item) => <tr key={`${item.clientId}-${item.occursOn}`}><td><time dateTime={item.occursOn}>{birthdayDateFormatter.format(asLocalDate(item.occursOn))}</time></td><td>{item.fullName}</td><td><ClientStatus status={item.status} /></td><td>{item.contactAllowed && item.preferredContact ? <><strong>{item.preferredContact.value}</strong><small>{item.preferredContact.type === 'phone' ? 'Telefone' : item.preferredContact.type === 'email' ? 'E-mail' : 'Outro'}</small></> : <span>Contato não autorizado</span>}</td></tr>)}</tbody></table></div><Pagination pagination={report.pagination} onPage={loadPage} /></Card>
}

function ClientResult({ report, loadPage }: { report: ClientReportResponse | null; loadPage: (page: number) => void }) {
  if (!report?.items.length) return <EmptyState title="Nenhum cliente" description="Não há cadastros que correspondam ao período e aos filtros." />
  return <><div className="report-metrics" aria-label="Totais da base filtrada"><Card title="Total"><strong>{report.totals.total}</strong></Card><Card title="Fixos"><strong>{report.totals.fixed}</strong></Card><Card title="Rotativos"><strong>{report.totals.rotating}</strong></Card><Card title="Ativos"><strong>{report.totals.active}</strong></Card></div><Card title={`${report.pagination.total} cliente${report.pagination.total === 1 ? '' : 's'}`}><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Cadastro</th><th>Cliente</th><th>Tipo</th><th>Situação</th><th>Plano no período</th></tr></thead><tbody>{report.items.map((item) => <tr key={item.clientId}><td>{dateFormatter.format(asLocalDate(item.registeredOn))}</td><td>{item.fullName}</td><td>{item.clientType === 'fixed' ? 'Fixo' : 'Rotativo'}</td><td><ClientStatus status={item.status} /></td><td>{item.plan ? <><strong>{item.plan.name}</strong><small>{dateFormatter.format(asLocalDate(item.plan.startsOn))}{item.plan.endsOn ? ` – ${dateFormatter.format(asLocalDate(item.plan.endsOn))}` : ' – vigente'}</small></> : <span>Sem plano ativo no período</span>}</td></tr>)}</tbody></table></div><Pagination pagination={report.pagination} onPage={loadPage} /></Card></>
}

function ActivityResult({ report, selectedBucket, granularity, openBucket, closeBucket }: { report: ClientActivityReportResponse | null; selectedBucket: string | null; granularity: ActivityGranularity; openBucket: (bucket: string, page?: number) => void; closeBucket: () => void }) {
  if (!report?.items.length) return <EmptyState title="Nenhuma atividade" description="Não há períodos que correspondam aos filtros." />
  if (selectedBucket) {
    const label = granularity === 'month' ? monthFormatter.format(asLocalDate(`${selectedBucket}-01`)) : selectedBucket
    return <Card title={`Clientes ativos em ${label}`} footer={<Button variant="secondary" onClick={closeBucket}>Voltar ao resumo</Button>}>{report.details.length ? <><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Cliente</th><th>Tipo</th><th>Situação</th><th>Presenças</th><th>Última presença</th></tr></thead><tbody>{report.details.map((item) => <tr key={item.clientId}><td>{item.fullName}</td><td>{item.clientType === 'fixed' ? 'Fixo' : 'Rotativo'}</td><td><ClientStatus status={item.status} /></td><td>{item.attendances}</td><td>{dateFormatter.format(asLocalDate(item.lastAttendanceOn))}</td></tr>)}</tbody></table></div>{report.pagination && <Pagination pagination={report.pagination} onPage={(page) => openBucket(selectedBucket, page)} />}</> : <EmptyState title="Nenhum cliente ativo" description="Nenhuma presença foi registrada neste período." />}</Card>
  }
  return <Card title={`Atividade por ${granularity === 'month' ? 'mês' : 'ano'}`}><p className="report-rule">Atividade conta clientes distintos com presença registrada. Reservas, faltas e cancelamentos não entram no total.</p><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Período</th><th>Clientes ativos</th><th>Presenças</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{report.items.map((item) => <tr key={item.period}><td>{granularity === 'month' ? monthFormatter.format(asLocalDate(`${item.period}-01`)) : item.period}</td><td>{item.activeClients}</td><td>{item.attendances}</td><td><Button variant="secondary" disabled={item.activeClients === 0} onClick={() => openBucket(item.period)}>Ver clientes</Button></td></tr>)}</tbody></table></div></Card>
}

function ClientStatus({ status }: { status: 'active' | 'inactive' }) {
  return <StatusBadge tone={status === 'active' ? 'success' : 'neutral'}>{status === 'active' ? 'Ativo' : 'Inativo'}</StatusBadge>
}
