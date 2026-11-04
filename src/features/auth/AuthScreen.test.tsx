import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { AuthScreen } from './AuthScreen'

function AuthTestApp() {
  return <AuthProvider><AuthScreen /></AuthProvider>
}

describe('fluxos de autenticação', () => {
  beforeEach(() => {
    window.location.hash = '#login'
  })

  it('apresenta login e envia as credenciais sem persistir token no navegador', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/session') {
        return new Response(JSON.stringify({ error: { message: 'Sessão necessária.' } }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        status: 'authenticated',
        session: {
          user: { id: 'user-a', email: 'ana@example.com' },
          organizationId: 'org-a',
          organizations: [{
            id: 'org-a',
            name: 'Clínica A',
            roleCode: 'owner',
            roleName: 'Proprietário',
            permissions: ['memberships.read', 'memberships.manage', 'roles.manage_privileged'],
          }],
          expiresAt: '2026-09-02T00:00:00.000Z',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthTestApp />)

    fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: 'ana@example.com' } })
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha segura 123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' })))
    expect(window.localStorage).toHaveLength(0)
  })

  it('mostra a mesma confirmação no pedido de recuperação', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/session') {
        return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        message: 'Se existir uma conta para esse e-mail, enviaremos as instruções de recuperação.',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    }))
    render(<AuthTestApp />)

    fireEvent.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }))
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'qualquer@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar instruções' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Se existir uma conta')
  })

  it('configura TOTP antes de concluir um acesso privilegiado e exibe recuperação', async () => {
    const session = {
      user: { id: 'user-a', email: 'ana@example.com' },
      organizationId: 'org-a',
      organizations: [],
      expiresAt: '2026-09-02T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/auth/session') {
        return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/api/auth/login') {
        return new Response(JSON.stringify({
          status: 'mfa_required',
          mfa: {
            challengeToken: 'challenge-token',
            mode: 'enrollment',
            manualKey: 'JBSWY3DPEHPK3PXP',
            otpauthUri: 'otpauth://totp/ClinicFlow',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        status: 'authenticated', session, recoveryCodes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthTestApp />)

    fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: 'ana@example.com' } })
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha segura 123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByRole('heading', { name: 'Proteja sua conta' })).toBeInTheDocument()
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Código de verificação'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verificar código' }))

    expect(await screen.findByRole('heading', { name: 'Guarde seus códigos' })).toBeInTheDocument()
    expect(screen.getByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/mfa/verify', expect.objectContaining({ method: 'POST' }))
  })

  it('informa que o cadastro é exclusivo por convite ao acessar sem token', async () => {
    window.location.hash = '#register'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })))
    render(<AuthTestApp />)

    expect(await screen.findByRole('heading', { name: 'Cadastro por convite' })).toBeInTheDocument()
    expect(screen.getByText(/precisa ter sido convidado por uma companhia/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ir para o login' })).toBeInTheDocument()
  })

  it('permite criar conta por link de convite sem exigir autenticação em dois fatores', async () => {
    window.location.hash = '#register?invite=token-convite-valido'
    const session = {
      user: { id: 'user-b', email: 'convidado@example.com' },
      organizationId: 'org-a',
      organizations: [{
        id: 'org-a',
        name: 'Clínica Alfa',
        roleCode: 'professional',
        roleName: 'Profissional',
        permissions: ['schedule.read'],
      }],
      expiresAt: '2026-09-02T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/auth/session') {
        return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/auth/invitations/lookup')) {
        return new Response(JSON.stringify({
          valid: true,
          organizationName: 'Clínica Alfa',
          roleName: 'Profissional',
          roleCode: 'professional',
          email: 'convidado@example.com',
          expiresAt: '2026-11-01T00:00:00.000Z',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/api/auth/register') {
        return new Response(JSON.stringify({
          status: 'authenticated',
          session,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthTestApp />)

    expect(await screen.findByRole('heading', { name: 'Crie sua conta' })).toBeInTheDocument()
    expect(screen.getByText('Convite para Clínica Alfa (Profissional)')).toBeInTheDocument()
    expect(screen.getByDisplayValue('convidado@example.com')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Defina sua senha'), { target: { value: 'minha-senha-segura-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar minha conta' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/register', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          inviteToken: 'token-convite-valido',
          email: 'convidado@example.com',
          password: 'minha-senha-segura-123',
        }),
      }))
    })
  })
})
