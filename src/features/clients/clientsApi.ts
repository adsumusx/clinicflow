import { apiRequest } from '@/features/auth'

export type ClientContactType = 'email' | 'phone' | 'other'
export type ClientType = 'fixed' | 'rotating'

export interface ClientContact {
  id: string
  preferred: boolean
  type: ClientContactType
  value: string
}

export interface ClientRecord {
  birthDate: string | null
  contacts: ClientContact[]
  createdAt: string
  documentNumber: string | null
  fullName: string
  id: string
  clientType: ClientType
  operationalRules: {
    planMode: 'contract' | 'credits_or_single_booking'
    recurrenceMode: 'reserved' | 'availability_only'
  }
  status: 'active' | 'inactive'
  updatedAt: string
}

export interface ClientInput {
  birthDate: string | null
  contacts: Array<Omit<ClientContact, 'id'>>
  documentNumber: string | null
  fullName: string
  clientType: ClientType
}

export interface ClientListResponse {
  items: ClientRecord[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export interface ClientClinicalRecord {
  id: string
  recordType: string
  content: string
  occurredAt: string
  signedAt: string | null
  authorProfessional: {
    id: string
    displayName: string
    registrationNumber: string | null
  }
}

export interface ClientProfile {
  client: ClientRecord
  access: {
    schedule: boolean
    plan: boolean
    finance: boolean
    history: boolean
    clinical?: boolean
  }
  schedule: null | Array<{
    id: string
    participantId: string
    serviceName: string
    unitName: string
    professionalName: string
    professionalRegistrationNumber?: string | null
    startsAt: string
    endsAt: string
    status: string
    participantStatus: string
  }>
  plan: null | Array<{
    id: string
    planId?: string
    name: string
    startsOn: string
    endsOn: string | null
    status: string
    agreedPriceCents: number
    currency: string
  }>
  finance: null | {
    openBalanceCents: number
    receivables: Array<{
      id: string
      dueOn: string
      status: string
      currency: string
      originalAmountCents: number
      paidAmountCents: number
      balanceCents: number
    }>
  }
  history: null | Array<{
    id: string
    action: string
    minimalMetadata: Record<string, unknown>
    occurredAt: string
  }>
  clinicalRecords?: ClientClinicalRecord[] | null
}

export interface ReplacementCreditRecord {
  id: string
  status: 'available' | 'consumed' | 'expired' | 'cancelled'
  expiresOn: string
  createdAt: string
  source: {
    participantId: string
    appointmentId: string
    startsAt: string
    status: 'absent' | 'cancelled'
  }
  consumption: null | {
    participantId: string
    appointmentId: string
    consumedAt: string
  }
}

export interface ReplacementCreditsResponse {
  balance: number
  credits: ReplacementCreditRecord[]
}

function clientPath(organizationId: string, clientId?: string) {
  const base = `/api/organizations/${organizationId}/clients`
  return clientId ? `${base}/${clientId}` : base
}

export function listClients(organizationId: string, options: {
  clientType?: ClientType
  page?: number
  pageSize?: number
  search?: string
} = {}) {
  const query = new URLSearchParams()
  if (options.clientType) query.set('type', options.clientType)
  if (options.search) query.set('q', options.search)
  query.set('page', String(options.page ?? 1))
  query.set('pageSize', String(options.pageSize ?? 20))
  return apiRequest<ClientListResponse>(`${clientPath(organizationId)}?${query}`)
}

export function getClientProfile(organizationId: string, clientId: string) {
  return apiRequest<ClientProfile>(`${clientPath(organizationId, clientId)}/profile`)
}

export function createClient(organizationId: string, input: ClientInput) {
  return apiRequest<ClientRecord>(clientPath(organizationId), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function updateClient(organizationId: string, clientId: string, input: ClientInput) {
  return apiRequest<ClientRecord>(clientPath(organizationId, clientId), {
    method: 'PUT', body: JSON.stringify(input),
  })
}

export function archiveClient(organizationId: string, clientId: string) {
  return apiRequest<void>(clientPath(organizationId, clientId), { method: 'DELETE' })
}

export function listReplacementCredits(organizationId: string, clientId: string) {
  return apiRequest<ReplacementCreditsResponse>(
    `${clientPath(organizationId, clientId)}/replacement-credits`,
  )
}

export function issueReplacementCredit(
  organizationId: string, clientId: string, sourceParticipantId: string,
) {
  return apiRequest<ReplacementCreditRecord>(
    `${clientPath(organizationId, clientId)}/replacement-credits`,
    { method: 'POST', body: JSON.stringify({ sourceParticipantId }) },
  )
}

export function cancelReplacementCredit(
  organizationId: string, clientId: string, creditId: string,
) {
  return apiRequest<ReplacementCreditRecord>(
    `${clientPath(organizationId, clientId)}/replacement-credits/${creditId}`,
    { method: 'DELETE' },
  )
}

export function listClientClinicalRecords(organizationId: string, clientId: string) {
  return apiRequest<{ items: ClientClinicalRecord[] }>(`${clientPath(organizationId, clientId)}/clinical-records`)
}

export function createClientClinicalRecord(
  organizationId: string,
  clientId: string,
  input: { recordType?: string; content: string; occurredAt?: string },
) {
  return apiRequest<ClientClinicalRecord>(`${clientPath(organizationId, clientId)}/clinical-records`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateProfessional(
  organizationId: string,
  professionalId: string,
  input: { registrationNumber?: string | null; displayName?: string },
) {
  return apiRequest<{ id: string; displayName: string; registrationNumber: string | null }>(
    `/api/organizations/${organizationId}/professionals/${professionalId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  )
}

export interface PlanRecord {
  id: string
  name: string
  priceCents: number
  currency: string
  billingRule: {
    frequency?: string
    dueDay?: number
    [key: string]: unknown
  }
  active: boolean
}

export interface ClientContractRecord {
  id: string
  clientId: string
  planId: string
  name: string
  startsOn: string
  endsOn: string | null
  agreedPriceCents: number
  currency: string
  status: 'draft' | 'active' | 'suspended' | 'ended' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface CreateContractInput {
  planId: string
  startsOn: string
  endsOn?: string | null
  agreedPriceCents?: number
  status?: 'active' | 'draft'
}

export interface UpdateContractInput {
  status?: 'active' | 'suspended' | 'ended' | 'cancelled'
  endsOn?: string | null
  agreedPriceCents?: number
}

export function listPlans(organizationId: string) {
  return apiRequest<PlanRecord[]>(`/api/organizations/${organizationId}/plans`)
}

export function createPlan(
  organizationId: string,
  input: { name: string; priceCents: number; billingRule?: Record<string, unknown> },
) {
  return apiRequest<PlanRecord>(`/api/organizations/${organizationId}/plans`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function listClientContracts(organizationId: string, clientId: string) {
  return apiRequest<ClientContractRecord[]>(`${clientPath(organizationId, clientId)}/contracts`)
}

export function createClientContract(
  organizationId: string,
  clientId: string,
  input: CreateContractInput,
) {
  return apiRequest<ClientContractRecord>(`${clientPath(organizationId, clientId)}/contracts`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateClientContract(
  organizationId: string,
  clientId: string,
  contractId: string,
  input: UpdateContractInput,
) {
  return apiRequest<ClientContractRecord>(`${clientPath(organizationId, clientId)}/contracts/${contractId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}
