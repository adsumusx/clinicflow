import { apiRequest } from '@/features/auth'

export type ResourceKind = 'modalities' | 'services' | 'rooms' | 'equipment'
export type ResourceStatusFilter = 'all' | 'active' | 'inactive'

export interface UnitOption {
  active: boolean
  id: string
  name: string
}

export interface BaseResource {
  active: boolean
  associationsCount: number
  createdAt: string
  id: string
  name: string
  updatedAt: string
}

export interface ModalityResource extends BaseResource {}

export interface ServiceResource extends BaseResource {
  defaultCapacity: number
  durationMinutes: number
  modalityId: string
  modalityName: string
}

export interface RoomResource extends BaseResource {
  capacity: number
  unitId: string
  unitName: string
}

export interface EquipmentResource extends BaseResource {
  quantity: number
  unitId: string
  unitName: string
}

export interface ResourceCatalog {
  equipment: EquipmentResource[]
  modalities: ModalityResource[]
  rooms: RoomResource[]
  services: ServiceResource[]
  units: UnitOption[]
}

export type ResourceRecord = ModalityResource | ServiceResource | RoomResource | EquipmentResource
export type ResourceInput = {
  active: boolean
  capacity?: number
  defaultCapacity?: number
  durationMinutes?: number
  modalityId?: string
  name: string
  quantity?: number
  unitId?: string
}

function resourcesPath(organizationId: string, kind?: ResourceKind, resourceId?: string) {
  const base = `/api/organizations/${organizationId}/resources`
  if (!kind) return base
  return `${base}/${kind}${resourceId ? `/${resourceId}` : ''}`
}

export function listResources(organizationId: string, status: ResourceStatusFilter = 'all') {
  return apiRequest<ResourceCatalog>(`${resourcesPath(organizationId)}?status=${status}`)
}

export function createResource(organizationId: string, kind: ResourceKind, input: ResourceInput) {
  return apiRequest<ResourceRecord>(resourcesPath(organizationId, kind), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function updateResource(
  organizationId: string, kind: ResourceKind, resourceId: string, input: ResourceInput,
) {
  return apiRequest<ResourceRecord>(resourcesPath(organizationId, kind, resourceId), {
    method: 'PUT', body: JSON.stringify(input),
  })
}
