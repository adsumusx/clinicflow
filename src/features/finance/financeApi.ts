import { apiRequest } from '@/features/auth'

export type ReceivableStatus = 'open' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'
export type PayableStatus = ReceivableStatus
export type FinancialPaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card' | 'transfer' | 'boleto' | 'other'

export interface FinancialPayment {
  amountCents: number
  createdAt: string
  externalReference: string | null
  id: string
  method: FinancialPaymentMethod
  paidAt: string
  reversalReason: string | null
  reversed: boolean
  reversesPaymentId: string | null
}

export interface Receivable {
  balanceCents: number
  cancellationReason: string | null
  cancelledAt: string | null
  categoryId: string
  categoryName: string
  clientId: string
  clientName: string
  competenceOn: string
  contractId: string | null
  createdAt: string
  currency: 'BRL'
  description: string
  dueOn: string
  history?: Array<{
    action: string
    id: string
    minimalMetadata: Record<string, unknown>
    occurredAt: string
  }>
  id: string
  installmentCount: number | null
  installmentNumber: number | null
  originalAmountCents: number
  paidAmountCents: number
  payments?: FinancialPayment[]
  recurrenceId: string | null
  status: ReceivableStatus
  updatedAt: string
}

export interface FinancialPaymentInput {
  amountCents: number
  externalReference?: string | null
  idempotencyKey: string
  method: FinancialPaymentMethod
  paidAt: string
}

export interface Payable {
  balanceCents: number
  cancellationReason: string | null
  cancelledAt: string | null
  categoryId: string
  categoryName: string
  competenceOn: string
  counterparty: string
  createdAt: string
  currency: 'BRL'
  description: string
  dueOn: string
  history?: Receivable['history']
  id: string
  installmentCount: number | null
  installmentNumber: number | null
  originalAmountCents: number
  paidAmountCents: number
  payments?: FinancialPayment[]
  recurrenceId: string | null
  status: PayableStatus
  updatedAt: string
}

export interface PayableInput {
  amountCents: number
  categoryId: string
  competenceOn: string
  counterparty: string
  description: string
  dueOn: string
  idempotencyKey?: string
  recurrence?: { frequency: 'monthly'; installmentCount: number } | null
}

export interface PayablesResult {
  items: Payable[]
  options: { categories: Array<{ id: string; name: string }> }
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  summary: { count: number; openBalanceCents: number; overdueBalanceCents: number }
}

export interface ReceivableInput {
  amountCents: number
  categoryId: string
  clientId: string
  competenceOn: string
  description: string
  dueOn: string
  idempotencyKey?: string
  recurrence?: { frequency: 'monthly'; installmentCount: number } | null
}

export interface ReceivablesResult {
  items: Receivable[]
  options: {
    categories: Array<{ id: string; name: string }>
    clients: Array<{ id: string; name: string }>
  }
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  summary: { count: number; openBalanceCents: number; overdueBalanceCents: number }
}

const basePath = (organizationId: string) => `/api/organizations/${organizationId}/receivables`
const payableBasePath = (organizationId: string) => `/api/organizations/${organizationId}/payables`

export function listReceivables(organizationId: string, filters: {
  page?: number
  search?: string
  status?: ReceivableStatus | ''
} = {}) {
  const query = new URLSearchParams({ page: String(filters.page ?? 1), pageSize: '20' })
  if (filters.search) query.set('q', filters.search)
  if (filters.status) query.set('status', filters.status)
  return apiRequest<ReceivablesResult>(`${basePath(organizationId)}?${query}`)
}

export function getReceivable(organizationId: string, receivableId: string) {
  return apiRequest<Receivable>(`${basePath(organizationId)}/${receivableId}`)
}

export function createReceivable(organizationId: string, input: ReceivableInput) {
  return apiRequest<{ items: Receivable[]; replayed: boolean }>(basePath(organizationId), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function generateContractReceivables(organizationId: string, input: {
  categoryId: string
  competenceOn: string
  contractId?: string | null
  idempotencyKey: string
}) {
  return apiRequest<{ items: Receivable[]; generatedCount: number; replayed: boolean }>(
    `${basePath(organizationId)}/generate`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function updateReceivable(
  organizationId: string, receivableId: string, input: ReceivableInput,
) {
  const { idempotencyKey: _key, recurrence: _recurrence, ...editable } = input
  return apiRequest<Receivable>(`${basePath(organizationId)}/${receivableId}`, {
    method: 'PUT', body: JSON.stringify(editable),
  })
}

export function cancelReceivable(organizationId: string, receivableId: string, reason: string) {
  return apiRequest<Receivable>(`${basePath(organizationId)}/${receivableId}`, {
    method: 'DELETE', body: JSON.stringify({ reason }),
  })
}

export function createReceivablePayment(
  organizationId: string, receivableId: string, input: FinancialPaymentInput | { payments: FinancialPaymentInput[] },
) {
  return apiRequest<{ payment?: FinancialPayment; payments?: FinancialPayment[]; replayed: boolean }>(
    `${basePath(organizationId)}/${receivableId}/payments`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function reverseReceivablePayment(
  organizationId: string, receivableId: string, paymentId: string,
  input: { idempotencyKey: string; reason: string; reversedAt: string },
) {
  return apiRequest<{ payment: FinancialPayment; replayed: boolean }>(
    `${basePath(organizationId)}/${receivableId}/payments/${paymentId}/reversal`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function listPayables(organizationId: string, filters: {
  page?: number
  search?: string
  status?: PayableStatus | ''
} = {}) {
  const query = new URLSearchParams({ page: String(filters.page ?? 1), pageSize: '20' })
  if (filters.search) query.set('q', filters.search)
  if (filters.status) query.set('status', filters.status)
  return apiRequest<PayablesResult>(`${payableBasePath(organizationId)}?${query}`)
}

export function getPayable(organizationId: string, payableId: string) {
  return apiRequest<Payable>(`${payableBasePath(organizationId)}/${payableId}`)
}

export function createPayable(organizationId: string, input: PayableInput) {
  return apiRequest<{ items: Payable[]; replayed: boolean }>(payableBasePath(organizationId), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function updatePayable(organizationId: string, payableId: string, input: PayableInput) {
  const { idempotencyKey: _key, recurrence: _recurrence, ...editable } = input
  return apiRequest<Payable>(`${payableBasePath(organizationId)}/${payableId}`, {
    method: 'PUT', body: JSON.stringify(editable),
  })
}

export function cancelPayable(organizationId: string, payableId: string, reason: string) {
  return apiRequest<Payable>(`${payableBasePath(organizationId)}/${payableId}`, {
    method: 'DELETE', body: JSON.stringify({ reason }),
  })
}

export function createPayablePayment(
  organizationId: string, payableId: string, input: FinancialPaymentInput | { payments: FinancialPaymentInput[] },
) {
  return apiRequest<{ payment?: FinancialPayment; payments?: FinancialPayment[]; replayed: boolean }>(
    `${payableBasePath(organizationId)}/${payableId}/payments`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function reversePayablePayment(
  organizationId: string, payableId: string, paymentId: string,
  input: { idempotencyKey: string; reason: string; reversedAt: string },
) {
  return apiRequest<{ payment: FinancialPayment; replayed: boolean }>(
    `${payableBasePath(organizationId)}/${payableId}/payments/${paymentId}/reversal`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function createFinancialCategory(
  organizationId: string, input: { kind: 'receivable' | 'payable' | 'both'; name: string },
) {
  return apiRequest<{ id: string; kind: string; name: string; active: boolean }>(
    `/api/organizations/${organizationId}/financial-categories`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}
