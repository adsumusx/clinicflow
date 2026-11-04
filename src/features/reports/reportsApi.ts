import { ApiError, apiRequest } from '@/features/auth'

export interface ReportFiltersCatalog {
  units: Array<{ id: string; name: string }>
  professionals: Array<{ id: string; displayName: string }>
  modalities: Array<{ id: string; name: string }>
  statuses: Array<{ value: 'active' | 'inactive'; label: string }>
}

export interface ReportFilters {
  from: string
  to: string
  unitId?: string
  professionalId?: string
  status?: 'active' | 'inactive'
}

export interface BirthdayReportItem {
  birthDate: string
  clientId: string
  contactAllowed: boolean
  fullName: string
  occursOn: string
  preferredContact: null | { type: 'email' | 'phone' | 'other'; value: string }
  status: 'active' | 'inactive'
}

export interface BirthdayReportResponse {
  appliedFilters: ReportFilters
  items: BirthdayReportItem[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export type ClientReportType = 'all' | 'fixed'

export interface ClientReportItem {
  clientId: string
  clientType: 'fixed' | 'rotating'
  fullName: string
  plan: null | {
    contractId: string
    name: string
    startsOn: string
    endsOn: string | null
  }
  registeredOn: string
  status: 'active' | 'inactive'
}

export interface ClientReportResponse {
  appliedFilters: ReportFilters & { clientType: ClientReportType }
  items: ClientReportItem[]
  pagination: BirthdayReportResponse['pagination']
  totals: {
    active: number
    fixed: number
    inactive: number
    rotating: number
    total: number
  }
}

export type ActivityGranularity = 'month' | 'year'

export interface ClientActivityPeriod {
  activeClients: number
  attendances: number
  period: string
  periodEnd: string
  periodStart: string
}

export interface ClientActivityDetail {
  attendances: number
  clientId: string
  clientType: 'fixed' | 'rotating'
  fullName: string
  lastAttendanceOn: string
  status: 'active' | 'inactive'
}

export interface ClientActivityReportResponse {
  appliedFilters: ReportFilters & {
    bucket: string | null
    granularity: ActivityGranularity
  }
  details: ClientActivityDetail[]
  items: ClientActivityPeriod[]
  pagination: BirthdayReportResponse['pagination'] | null
}

export interface BusinessDashboardReportResponse {
  appliedFilters: ReportFilters
  financial: {
    billedCents: number
    receivedCents: number
    outstandingCents: number
  }
  operational: {
    appointments: number
    completedAppointments: number
    attendances: number
    absences: number
    attendanceRate: number
  }
}

export interface EquipmentUsageReportItem {
  allocatedQuantity: number
  appointments: number
  attendances: number
  availableQuantity: number
  equipmentId: string
  equipmentName: string
  lastUsedOn: string
  modalityId: string
  modalityName: string
  unitId: string
  unitName: string
}

export interface EquipmentUsageReportResponse {
  appliedFilters: ReportFilters & { modalityId: string | null }
  items: EquipmentUsageReportItem[]
  pagination: BirthdayReportResponse['pagination']
  totals: {
    allocatedQuantity: number
    appointments: number
    equipmentTypes: number
  }
}

export type ProspectStage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'lost' | 'converted'

export interface ProspectReportItem {
  closedOn: string | null
  createdOn: string
  cycleDays: number | null
  fullName: string
  ownerDisplayName: string | null
  ownerProfessionalId: string | null
  prospectId: string
  source: string
  stage: ProspectStage
}

export interface ProspectReportResponse {
  appliedFilters: ReportFilters
  items: ProspectReportItem[]
  pagination: BirthdayReportResponse['pagination']
  sources: Array<{
    conversionRate: number
    converted: number
    lost: number
    source: string
    total: number
  }>
  stages: Record<ProspectStage, number>
  totals: {
    averageCycleDays: number
    conversionRate: number
    converted: number
    lossRate: number
    lost: number
    open: number
    total: number
  }
}

function reportQuery(filters: ReportFilters, page?: number) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to })
  if (filters.unitId) query.set('unitId', filters.unitId)
  if (filters.professionalId) query.set('professionalId', filters.professionalId)
  if (filters.status) query.set('status', filters.status)
  if (page) query.set('page', String(page))
  query.set('pageSize', '25')
  return query
}

export function getReportFilters(organizationId: string) {
  return apiRequest<ReportFiltersCatalog>(`/api/organizations/${organizationId}/reports/filters`)
}

export function listBirthdayReport(
  organizationId: string, filters: ReportFilters, page = 1,
) {
  return apiRequest<BirthdayReportResponse>(
    `/api/organizations/${organizationId}/reports/birthdays?${reportQuery(filters, page)}`,
  )
}

export async function downloadBirthdayReport(
  organizationId: string, filters: ReportFilters,
) {
  const response = await fetch(
    `/api/organizations/${organizationId}/reports/birthdays/export?${reportQuery(filters)}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    let message = 'Não foi possível exportar o relatório.'
    try {
      const body = await response.json() as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // Respostas não JSON recebem uma mensagem segura.
    }
    throw new ApiError(response.status, message)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = disposition.match(/filename="([^"]+)"/u)?.[1] ?? 'aniversariantes.csv'
  return { blob: await response.blob(), filename }
}

export function listClientReport(
  organizationId: string, filters: ReportFilters, clientType: ClientReportType, page = 1,
) {
  const query = reportQuery(filters, page)
  query.set('clientType', clientType)
  return apiRequest<ClientReportResponse>(
    `/api/organizations/${organizationId}/reports/clients?${query}`,
  )
}

export function listClientActivityReport(
  organizationId: string,
  filters: ReportFilters,
  granularity: ActivityGranularity,
  bucket?: string,
  page = 1,
) {
  const query = reportQuery(filters, page)
  query.set('granularity', granularity)
  if (bucket) query.set('bucket', bucket)
  return apiRequest<ClientActivityReportResponse>(
    `/api/organizations/${organizationId}/reports/client-activity?${query}`,
  )
}

async function downloadReport(url: string, fallbackFilename: string) {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) {
    let message = 'Não foi possível exportar o relatório.'
    try {
      const body = await response.json() as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // Respostas não JSON recebem uma mensagem segura.
    }
    throw new ApiError(response.status, message)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = disposition.match(/filename="([^"]+)"/u)?.[1] ?? fallbackFilename
  return { blob: await response.blob(), filename }
}

export function downloadClientReport(
  organizationId: string, filters: ReportFilters, clientType: ClientReportType,
) {
  const query = reportQuery(filters)
  query.set('clientType', clientType)
  return downloadReport(
    `/api/organizations/${organizationId}/reports/clients/export?${query}`,
    'clientes.csv',
  )
}

export function downloadClientActivityReport(
  organizationId: string,
  filters: ReportFilters,
  granularity: ActivityGranularity,
  bucket?: string,
) {
  const query = reportQuery(filters)
  query.set('granularity', granularity)
  if (bucket) query.set('bucket', bucket)
  return downloadReport(
    `/api/organizations/${organizationId}/reports/client-activity/export?${query}`,
    'atividade-clientes.csv',
  )
}

export function getBusinessDashboardReport(
  organizationId: string, filters: ReportFilters,
) {
  return apiRequest<BusinessDashboardReportResponse>(
    `/api/organizations/${organizationId}/reports/dashboard?${reportQuery(filters)}`,
  )
}

export function downloadBusinessDashboardReport(
  organizationId: string, filters: ReportFilters,
) {
  return downloadReport(
    `/api/organizations/${organizationId}/reports/dashboard/export?${reportQuery(filters)}`,
    'dashboard-negocio.csv',
  )
}

export function listEquipmentUsageReport(
  organizationId: string,
  filters: ReportFilters,
  modalityId?: string,
  page = 1,
) {
  const query = reportQuery(filters, page)
  if (modalityId) query.set('modalityId', modalityId)
  return apiRequest<EquipmentUsageReportResponse>(
    `/api/organizations/${organizationId}/reports/equipment-usage?${query}`,
  )
}

export function downloadEquipmentUsageReport(
  organizationId: string,
  filters: ReportFilters,
  modalityId?: string,
) {
  const query = reportQuery(filters)
  if (modalityId) query.set('modalityId', modalityId)
  return downloadReport(
    `/api/organizations/${organizationId}/reports/equipment-usage/export?${query}`,
    'aparelhos-utilizados.csv',
  )
}

export function listProspectReport(
  organizationId: string,
  filters: ReportFilters,
  page = 1,
) {
  return apiRequest<ProspectReportResponse>(
    `/api/organizations/${organizationId}/reports/prospects?${reportQuery(filters, page)}`,
  )
}

export function downloadProspectReport(
  organizationId: string,
  filters: ReportFilters,
) {
  return downloadReport(
    `/api/organizations/${organizationId}/reports/prospects/export?${reportQuery(filters)}`,
    'prospeccoes.csv',
  )
}
