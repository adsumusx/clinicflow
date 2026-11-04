export interface OrganizationAccess {
  id: string
  name: string
  roleCode: string
  roleName: string
  permissions: string[]
}

export interface AuthSession {
  user: { id: string; email: string }
  organizationId: string | null
  organizations: OrganizationAccess[]
  expiresAt: string
}

export interface MfaRequiredResult {
  status: 'mfa_required'
  mfa: {
    challengeToken: string
    mode: 'enrollment' | 'authentication'
    manualKey?: string
    otpauthUri?: string
  }
}

export interface AuthenticatedResult {
  status: 'authenticated'
  session: AuthSession
  recoveryCodes?: string[]
}

export interface InvitationLookup {
  valid: boolean
  organizationName: string
  roleCode: string
  roleName: string
  email?: string | null
  expiresAt: string
}

export type AuthAttemptResult = MfaRequiredResult | AuthenticatedResult

interface ApiErrorBody {
  error?: { message?: string }
  message?: string
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body
      ? { 'Content-Type': 'application/json', ...init.headers }
      : init?.headers,
  })
  if (!response.ok) {
    let body: ApiErrorBody = {}
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      // A fronteira converte respostas não JSON em uma mensagem segura.
    }
    throw new ApiError(
      response.status,
      body.error?.message ?? body.message ?? 'Não foi possível concluir a solicitação.',
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
