import { apiRequest } from '@/features/auth'
import type { ClientRecord, ClientType } from '@/features/clients'

export type ProspectStage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'lost' | 'converted'
export type ProspectContactType = 'email' | 'phone' | 'other'
export type ProspectInteractionType = 'call' | 'email' | 'message' | 'meeting' | 'note' | 'stage_change' | 'conversion'

export interface ProspectContact {
  id: string
  preferred: boolean
  type: ProspectContactType
  value: string
}

export interface ProspectInteraction {
  id: string
  notes: string | null
  occurredAt: string
  type: ProspectInteractionType
}

export interface ProspectOwner {
  displayName: string
  id: string
}

export interface ProspectRecord {
  contacts: ProspectContact[]
  convertedAt: string | null
  convertedClientId: string | null
  createdAt: string
  fullName: string
  id: string
  interactions: ProspectInteraction[]
  nextActionAt: string | null
  nextActionNote: string | null
  owner: ProspectOwner | null
  source: string
  stage: ProspectStage
  updatedAt: string
}

export interface ProspectInput {
  contacts: Array<Omit<ProspectContact, 'id'>>
  fullName: string
  nextActionAt: string | null
  nextActionNote: string | null
  ownerProfessionalId: string | null
  source: string
  stage: Exclude<ProspectStage, 'converted'>
}

export interface ProspectListResponse {
  items: ProspectRecord[]
  owners: ProspectOwner[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  stageCounts: Partial<Record<ProspectStage, number>>
}

export interface ProspectConversionResult {
  client: ClientRecord
  created: boolean
  prospect: ProspectRecord
}

function prospectPath(organizationId: string, prospectId?: string) {
  const base = `/api/organizations/${organizationId}/prospects`
  return prospectId ? `${base}/${prospectId}` : base
}

export function listProspects(organizationId: string, options: {
  page?: number
  pageSize?: number
  search?: string
  stage?: ProspectStage
} = {}) {
  const query = new URLSearchParams()
  if (options.stage) query.set('stage', options.stage)
  if (options.search) query.set('q', options.search)
  query.set('page', String(options.page ?? 1))
  query.set('pageSize', String(options.pageSize ?? 50))
  return apiRequest<ProspectListResponse>(`${prospectPath(organizationId)}?${query}`)
}

export function getProspect(organizationId: string, prospectId: string) {
  return apiRequest<ProspectRecord>(prospectPath(organizationId, prospectId))
}

export function createProspect(organizationId: string, input: ProspectInput) {
  return apiRequest<ProspectRecord>(prospectPath(organizationId), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function updateProspect(organizationId: string, prospectId: string, input: ProspectInput) {
  return apiRequest<ProspectRecord>(prospectPath(organizationId, prospectId), {
    method: 'PUT', body: JSON.stringify(input),
  })
}

export function addProspectInteraction(
  organizationId: string,
  prospectId: string,
  input: { notes: string; occurredAt?: string; type: Exclude<ProspectInteractionType, 'stage_change' | 'conversion'> },
) {
  return apiRequest<ProspectInteraction>(`${prospectPath(organizationId, prospectId)}/interactions`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function convertProspect(organizationId: string, prospectId: string, input: {
  birthDate: string | null
  clientType: ClientType
  documentNumber: string | null
}) {
  return apiRequest<ProspectConversionResult>(`${prospectPath(organizationId, prospectId)}/convert`, {
    method: 'POST', body: JSON.stringify(input),
  })
}
