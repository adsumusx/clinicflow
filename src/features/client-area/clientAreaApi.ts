import { apiRequest } from '@/features/auth'

export type ClientAreaPageId = 'client-home' | 'my-appointments' | 'my-invoices' | 'my-content' | 'contact' | 'my-profile'

export interface OwnInvoice {
  id: string
  description: string
  competenceOn: string
  dueOn: string
  originalAmountCents: number
  paidAmountCents: number
  balanceCents: number
  currency: 'BRL'
  status: 'open' | 'partially_paid' | 'overdue'
}

export interface OwnInvoicesPayload {
  items: OwnInvoice[]
  summary: { count: number; openBalanceCents: number; overdueBalanceCents: number }
}

export interface OwnAppointment {
  id: string
  participantId: string
  startsAt: string
  endsAt: string
  status: 'scheduled' | 'completed' | 'cancelled'
  participantStatus: 'booked' | 'confirmed' | 'attended' | 'absent' | 'cancelled'
  service: { id: string; name: string }
  professional: { id: string; displayName: string; registrationNumber?: string | null }
  unit: { id: string; name: string; timezone: string }
  room: { id: string; name: string } | null
  checkedInAt: string | null
  checkIn: {
    allowed: boolean
    reason: 'already_checked_in' | 'disabled' | 'unavailable' | 'too_early' | 'window_closed' | null
    opensAt: string
    closesAt: string
  }
  replacementCreditId: string | null
}

export interface ClientAreaPayload {
  client: {
    id: string
    fullName: string
    birthDate: string | null
    clientType: 'fixed' | 'rotating'
    status: string
    contacts: Array<{ id: string; type: 'email' | 'phone' | 'other'; value: string; preferred: boolean }>
  }
  organization: { id: string; name: string }
  checkInPolicy: { enabled: boolean; beforeMinutes: number; afterMinutes: number }
  nextAppointment: OwnAppointment | null
  activeContract?: {
    id: string
    planId?: string
    name: string
    startsOn: string
    endsOn: string | null
    status: string
    agreedPriceCents: number
    currency: string
  } | null
}

export interface WaitlistAppointment {
  id: string
  startsAt: string
  endsAt: string
  capacity?: number
  occupancy?: number
  service: { id: string; name: string }
  professional: { id: string; displayName: string; registrationNumber?: string | null }
  unit: { id: string; name: string; timezone: string }
  room: { id: string; name: string } | null
}

export interface WaitlistEntry {
  id: string
  appointment: WaitlistAppointment
  status: 'queued' | 'offered'
  position: number
  queuedAt: string
  offer: null | {
    id: string
    status: 'active'
    offeredAt: string
    expiresAt: string
  }
}

export interface OwnWaitlistPayload {
  entries: WaitlistEntry[]
  eligibleAppointments: WaitlistAppointment[]
}

export interface ReplacementCredit {
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

export interface OwnReplacementCreditsPayload {
  balance: number
  credits: ReplacementCredit[]
  eligibleAppointments: WaitlistAppointment[]
}

export type ClinicalContentData = unknown

export interface PublishedAssessment {
  id: string
  type: string
  data: ClinicalContentData
  assessedAt: string
  professional: { id: string; displayName: string; registrationNumber?: string | null }
}

export interface PublishedWorkoutPlan {
  id: string
  title: string
  instructions: ClinicalContentData
  validUntil: string | null
  createdAt: string
  professional: { id: string; displayName: string; registrationNumber?: string | null }
}

export interface OwnClinicalContentPayload {
  assessments: PublishedAssessment[]
  workoutPlans: PublishedWorkoutPlan[]
}

export interface ContactChannel {
  id: string
  channel: 'phone' | 'email' | 'whatsapp'
  label: string
  displayValue: string
  href: string
}

export interface OwnContactChannelsPayload {
  channels: ContactChannel[]
}

const base = (organizationId: string) => `/api/organizations/${organizationId}/client-area`

export function getClientArea(organizationId: string) {
  return apiRequest<ClientAreaPayload>(base(organizationId))
}

export function getOwnAppointments(organizationId: string) {
  return apiRequest<{ appointments: OwnAppointment[] }>(`${base(organizationId)}/appointments`)
}

export function selfCheckIn(organizationId: string, appointmentId: string) {
  return apiRequest<OwnAppointment>(`${base(organizationId)}/appointments/${appointmentId}/check-in`, {
    method: 'POST',
  })
}

export function getOwnWaitlist(organizationId: string) {
  return apiRequest<OwnWaitlistPayload>(`${base(organizationId)}/waitlist`)
}

export function joinWaitlist(organizationId: string, appointmentId: string) {
  return apiRequest<WaitlistEntry>(`${base(organizationId)}/appointments/${appointmentId}/interest`, {
    method: 'POST',
  })
}

export function leaveWaitlist(organizationId: string, appointmentId: string) {
  return apiRequest<{ id: string; status: 'cancelled' }>(
    `${base(organizationId)}/appointments/${appointmentId}/interest`,
    { method: 'DELETE' },
  )
}

export function confirmWaitlistOffer(organizationId: string, appointmentId: string) {
  return apiRequest<OwnAppointment>(
    `${base(organizationId)}/appointments/${appointmentId}/waitlist/confirm`,
    { method: 'POST' },
  )
}

export function getOwnReplacementCredits(organizationId: string) {
  return apiRequest<OwnReplacementCreditsPayload>(`${base(organizationId)}/replacement-credits`)
}

export function getOwnPublishedClinicalContent(organizationId: string) {
  return apiRequest<OwnClinicalContentPayload>(`${base(organizationId)}/clinical-content`)
}

export function getOwnContactChannels(organizationId: string) {
  return apiRequest<OwnContactChannelsPayload>(`${base(organizationId)}/contact`)
}

export function getOwnInvoices(organizationId: string) {
  return apiRequest<OwnInvoicesPayload>(`${base(organizationId)}/invoices`)
}

export function bookWithReplacement(organizationId: string, appointmentId: string) {
  return apiRequest<OwnAppointment>(
    `${base(organizationId)}/appointments/${appointmentId}/replacement`,
    { method: 'POST' },
  )
}
