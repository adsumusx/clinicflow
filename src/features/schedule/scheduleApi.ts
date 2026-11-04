import { apiRequest } from '@/features/auth'

export type AvailabilityKind = 'working_hours' | 'break' | 'unavailable' | 'vacation'

export interface ScheduleOption {
  id: string
  name?: string
  displayName?: string
  fullName?: string
  unitId?: string
  timezone?: string
  durationMinutes?: number
  defaultCapacity?: number
  quantity?: number
  clientType?: 'fixed' | 'rotating'
}

export interface AvailabilityRule {
  active: boolean
  endsAt: string | null
  id: string
  kind: AvailabilityKind
  label: string | null
  localEndTime: string | null
  localStartTime: string | null
  professionalId: string
  professionalName: string
  startsAt: string | null
  timezone: string
  unitId: string
  unitName: string
  weekday: number | null
}

export interface AppointmentRecord {
  appointmentType: 'individual' | 'class'
  cancelledAt: string | null
  client: { id: string; fullName: string } | null
  endsAt: string
  id: string
  occupancy: number
  equipment: Array<{ id: string; name: string; quantity: number }>
  participants: Array<{
    id: string
    client: { id: string; fullName: string }
    status: 'booked' | 'confirmed' | 'attended' | 'absent' | 'cancelled'
    statusReason: string | null
    bookedAt: string
    history: Array<{
      id: string
      fromStatus: string | null
      toStatus: string
      reason: string | null
      actorMembershipId: string | null
      occurredAt: string
    }>
  }>
  waitlist: Array<{
    id: string
    client: { id: string; fullName: string }
    status: 'queued' | 'offered'
    position: number
    queuedAt: string
    offer: null | {
      id: string
      status: 'active'
      offeredAt: string
      expiresAt: string
    }
  }>
  professional: { id: string; displayName: string }
  room: { id: string; name: string } | null
  service: { id: string; name: string; durationMinutes: number }
  startsAt: string
  status: 'scheduled' | 'completed' | 'cancelled'
  unit: { id: string; name: string; timezone: string }
  capacity: number
  recurrence: null | {
    id: string
    occurrenceIndex: number
    frequency: 'weekly'
    interval: number
    count: number
    timezone: string
  }
}

export interface SchedulePayload {
  appointments: AppointmentRecord[]
  clients: ScheduleOption[]
  equipment: ScheduleOption[]
  professionals: ScheduleOption[]
  rooms: ScheduleOption[]
  services: ScheduleOption[]
  units: ScheduleOption[]
}

export interface AvailabilityPayload extends Omit<SchedulePayload, 'appointments'> {
  rules: AvailabilityRule[]
}

export interface AppointmentInput {
  clientId: string
  professionalId: string
  roomId: string | null
  serviceId: string
  startsAt: string
  unitId: string
  equipment: Array<{ equipmentId: string; quantity: number }>
}

export interface ClassAppointmentInput extends Omit<AppointmentInput, 'clientId'> {
  capacity: number
  clientIds: string[]
}

export interface AppointmentSeriesInput extends AppointmentInput {
  recurrence: { frequency: 'weekly'; interval: number; count: number; timezone: string }
}

export type AvailabilityInput = Omit<
  AvailabilityRule,
  'id' | 'professionalName' | 'unitName'
>

const base = (organizationId: string) => `/api/organizations/${organizationId}`

export function getSchedule(organizationId: string, from: string, to: string) {
  const query = new URLSearchParams({ from, to })
  return apiRequest<SchedulePayload>(`${base(organizationId)}/appointments?${query}`)
}

export function createAppointment(organizationId: string, input: AppointmentInput) {
  return apiRequest<AppointmentRecord>(`${base(organizationId)}/appointments`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function createClassAppointment(organizationId: string, input: ClassAppointmentInput) {
  return apiRequest<AppointmentRecord>(`${base(organizationId)}/appointments/classes`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function addAppointmentParticipant(
  organizationId: string, appointmentId: string, clientId: string,
) {
  return apiRequest<AppointmentRecord>(
    `${base(organizationId)}/appointments/${appointmentId}/participants`,
    { method: 'POST', body: JSON.stringify({ clientId }) },
  )
}

export function cancelAppointmentParticipant(
  organizationId: string, appointmentId: string, clientId: string,
) {
  return apiRequest<AppointmentRecord>(
    `${base(organizationId)}/appointments/${appointmentId}/participants/${clientId}`,
    { method: 'DELETE' },
  )
}

export function updateAppointmentParticipantStatus(
  organizationId: string, appointmentId: string, participantId: string,
  status: 'confirmed' | 'attended' | 'absent' | 'cancelled', reason?: string,
) {
  return apiRequest<AppointmentRecord>(
    `${base(organizationId)}/appointments/${appointmentId}/participants/${participantId}/status`,
    { method: 'PATCH', body: JSON.stringify({ status, reason }) },
  )
}

export function createAppointmentSeries(organizationId: string, input: AppointmentSeriesInput) {
  return apiRequest<{ id: string; appointments: AppointmentRecord[] }>(
    `${base(organizationId)}/appointment-series`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function updateAppointmentOccurrences(
  organizationId: string, appointmentId: string,
  input: AppointmentInput & { scope: 'single' | 'future' },
) {
  return apiRequest<{ scope: 'single' | 'future'; appointments: AppointmentRecord[] }>(
    `${base(organizationId)}/appointments/${appointmentId}/occurrences`,
    { method: 'PUT', body: JSON.stringify(input) },
  )
}

export function updateAppointment(
  organizationId: string, appointmentId: string, input: AppointmentInput,
) {
  return apiRequest<AppointmentRecord>(`${base(organizationId)}/appointments/${appointmentId}`, {
    method: 'PUT', body: JSON.stringify(input),
  })
}

export function cancelAppointment(organizationId: string, appointmentId: string) {
  return apiRequest<AppointmentRecord>(`${base(organizationId)}/appointments/${appointmentId}`, {
    method: 'DELETE',
  })
}

export function listAvailability(organizationId: string) {
  return apiRequest<AvailabilityPayload>(`${base(organizationId)}/availability-rules`)
}

export function createAvailability(organizationId: string, input: AvailabilityInput) {
  return apiRequest<AvailabilityRule>(`${base(organizationId)}/availability-rules`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function updateAvailability(
  organizationId: string, ruleId: string, input: AvailabilityInput,
) {
  return apiRequest<AvailabilityRule>(`${base(organizationId)}/availability-rules/${ruleId}`, {
    method: 'PUT', body: JSON.stringify(input),
  })
}
