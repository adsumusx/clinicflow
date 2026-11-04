import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ApiError,
  apiRequest,
  type AuthAttemptResult,
  type AuthenticatedResult,
  type AuthSession,
  type InvitationLookup,
} from './authApi'

interface Credentials {
  email: string
  password: string
}

export interface Registration {
  inviteToken?: string
  email?: string
  password: string
  organizationName?: string
}

interface AuthContextValue {
  loading: boolean
  session: AuthSession | null
  login(credentials: Credentials): Promise<AuthAttemptResult>
  register(registration: Registration): Promise<AuthAttemptResult>
  lookupInvitation(token: string): Promise<InvitationLookup>
  verifyMfa(challengeToken: string, code: string): Promise<AuthenticatedResult>
  acceptSession(session: AuthSession): void
  logout(): Promise<void>
  refresh(): Promise<void>
  selectOrganization(organizationId: string): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<AuthSession | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSession(await apiRequest<AuthSession>('/api/auth/session'))
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      setSession(null)
    }
  }, [])

  useEffect(() => {
    void refresh().finally(() => setLoading(false))
  }, [refresh])

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    session,
    async login(credentials) {
      const result = await apiRequest<AuthAttemptResult>('/api/auth/login', {
        method: 'POST', body: JSON.stringify(credentials),
      })
      if (result.status === 'authenticated') setSession(result.session)
      return result
    },
    async register(registration) {
      const result = await apiRequest<AuthAttemptResult>('/api/auth/register', {
        method: 'POST', body: JSON.stringify(registration),
      })
      if (result.status === 'authenticated') setSession(result.session)
      return result
    },
    async lookupInvitation(token) {
      return apiRequest<InvitationLookup>(`/api/auth/invitations/lookup?token=${encodeURIComponent(token)}`)
    },
    async verifyMfa(challengeToken, code) {
      const result = await apiRequest<AuthenticatedResult>('/api/auth/mfa/verify', {
        method: 'POST', body: JSON.stringify({ challengeToken, code }),
      })
      if (!result.recoveryCodes) setSession(result.session)
      return result
    },
    acceptSession(nextSession) {
      setSession(nextSession)
    },
    async logout() {
      await apiRequest<void>('/api/auth/logout', { method: 'POST' })
      setSession(null)
      window.location.hash = 'login'
    },
    refresh,
    async selectOrganization(organizationId) {
      setSession(await apiRequest<AuthSession>('/api/organizations/select', {
        method: 'POST', body: JSON.stringify({ organizationId }),
      }))
    },
  }), [loading, refresh, session])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider')
  return context
}
