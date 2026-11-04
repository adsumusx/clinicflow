import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/shared/ui'
import { apiRequest, type AuthSession, type InvitationLookup, type MfaRequiredResult } from './authApi'
import { useAuth } from './AuthProvider'
import './auth.css'

type AuthMode = 'login' | 'register' | 'forgot' | 'reset'

function getMode(): AuthMode {
  const route = window.location.hash.slice(1).split('?')[0]
  if (route === 'register' || route === 'convite' || route === 'invite' || route === 'forgot-password' || route === 'reset-password') {
    return route === 'forgot-password' ? 'forgot' : route === 'reset-password' ? 'reset' : 'register'
  }
  return 'login'
}

function getInviteToken(): string | null {
  const query = window.location.hash.split('?')[1] ?? ''
  const params = new URLSearchParams(query)
  return params.get('invite') ?? params.get('token')
}

function Field({
  label,
  name,
  type = 'text',
  defaultValue,
  readOnly,
  autoComplete,
  minLength,
  maxLength,
  inputMode,
  required = true,
}: {
  label: string
  name: string
  type?: string
  defaultValue?: string
  readOnly?: boolean
  autoComplete?: string
  minLength?: number
  maxLength?: number
  inputMode?: 'numeric' | 'text'
  required?: boolean
}) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        readOnly={readOnly}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
        inputMode={inputMode}
        required={required}
      />
    </label>
  )
}

export function AuthScreen() {
  const auth = useAuth()
  const [mode, setMode] = useState<AuthMode>(getMode)
  const [inviteToken, setInviteToken] = useState<string | null>(getInviteToken)
  const [inviteInfo, setInviteInfo] = useState<InvitationLookup | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mfa, setMfa] = useState<MfaRequiredResult['mfa'] | null>(null)
  const [recovery, setRecovery] = useState<{ codes: string[]; session: AuthSession } | null>(null)

  useEffect(() => {
    function onHashChange() {
      const nextMode = getMode()
      const token = getInviteToken()
      setMode(nextMode)
      setInviteToken(token)
      setError(null)
      setMessage(null)
      setMfa(null)
      setRecovery(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (mode === 'register' && inviteToken) {
      setInviteLoading(true)
      setError(null)
      auth.lookupInvitation(inviteToken)
        .then((info) => {
          setInviteInfo(info)
        })
        .catch((err) => {
          setInviteInfo(null)
          setError(err instanceof Error ? err.message : 'Convite inválido ou expirado.')
        })
        .finally(() => {
          setInviteLoading(false)
        })
    } else {
      setInviteInfo(null)
      setInviteLoading(false)
    }
  }, [mode, inviteToken, auth])

  function navigate(nextMode: AuthMode) {
    const route = nextMode === 'forgot' ? 'forgot-password' : nextMode === 'reset' ? 'reset-password' : nextMode
    window.location.hash = route
    setMode(nextMode)
    setError(null)
    setMessage(null)
    setMfa(null)
    setRecovery(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    const data = new FormData(event.currentTarget)
    try {
      if (mfa) {
        const result = await auth.verifyMfa(mfa.challengeToken, String(data.get('code')))
        if (result.recoveryCodes) {
          setRecovery({ codes: result.recoveryCodes, session: result.session })
          setMfa(null)
        } else {
          window.location.hash = 'dashboard'
        }
      } else if (mode === 'login') {
        const result = await auth.login({ email: String(data.get('email')), password: String(data.get('password')) })
        if (result.status === 'mfa_required') setMfa(result.mfa)
        else window.location.hash = 'dashboard'
      } else if (mode === 'register') {
        if (!inviteToken) {
          throw new Error('O cadastro no sistema é permitido apenas mediante convite de uma companhia.')
        }
        const result = await auth.register({
          inviteToken,
          email: inviteInfo?.email ?? String(data.get('email')),
          password: String(data.get('password')),
        })
        if (result.status === 'mfa_required') setMfa(result.mfa)
        else window.location.hash = 'dashboard'
      } else if (mode === 'forgot') {
        const response = await apiRequest<{ message: string }>('/api/auth/password/forgot', {
          method: 'POST', body: JSON.stringify({ email: String(data.get('email')) }),
        })
        setMessage(response.message)
      } else {
        const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
        const response = await apiRequest<{ message: string }>('/api/auth/password/reset', {
          method: 'POST',
          body: JSON.stringify({ token: params.get('token'), password: String(data.get('password')) }),
        })
        setMessage(response.message)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível concluir a solicitação.')
    } finally {
      setBusy(false)
    }
  }

  const titles = {
    login: ['Boas-vindas', 'Entre para acessar sua clínica.'],
    register: inviteInfo
      ? ['Crie sua conta', `Convite para ${inviteInfo.organizationName} (${inviteInfo.roleName})`]
      : ['Cadastro por convite', 'Acesso exclusivo para convidados de uma companhia.'],
    forgot: ['Recupere seu acesso', 'Enviaremos instruções se a conta estiver cadastrada.'],
    reset: ['Defina uma nova senha', 'Use pelo menos 12 caracteres.'],
  }
  const activeTitle = recovery
    ? ['Guarde seus códigos', 'Cada código de recuperação funciona uma única vez.']
    : mfa?.mode === 'enrollment'
      ? ['Proteja sua conta', 'Configure um aplicativo autenticador para concluir o acesso privilegiado.']
      : mfa
        ? ['Confirme seu acesso', 'Digite o código do aplicativo autenticador ou um código de recuperação.']
        : titles[mode]

  function finishEnrollment() {
    if (!recovery) return
    auth.acceptSession(recovery.session)
    window.location.hash = 'dashboard'
  }

  return (
    <main className="auth-layout">
      <section className="auth-panel" aria-labelledby="auth-title">
        <a className="auth-brand" href="#login" onClick={() => navigate('login')}>
          <span aria-hidden="true">CF</span>
          <strong>ClinicFlow</strong>
        </a>
        <header>
          <h1 id="auth-title">{activeTitle[0]}</h1>
          <p>{activeTitle[1]}</p>
        </header>

        {recovery ? (
          <section className="auth-recovery" aria-label="Códigos de recuperação">
            <ul>{recovery.codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
            <p>Salve-os em um gerenciador de senhas. Eles não serão exibidos novamente.</p>
            <Button type="button" onClick={finishEnrollment}>Já guardei os códigos</Button>
          </section>
        ) : mode === 'register' && !inviteToken ? (
          <section className="auth-invite-notice" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: 'var(--color-on-surface-variant, #64748b)', lineHeight: 1.5 }}>
              Para criar uma conta no ClinicFlow, você precisa ter sido convidado por uma companhia.
              O cadastro de novas clínicas é realizado diretamente no banco de dados.
            </p>
            <p style={{ color: 'var(--color-on-surface-variant, #64748b)', lineHeight: 1.5 }}>
              Caso tenha recebido um link de convite ou QR Code da sua clínica, acesse-o para concluir seu cadastro.
            </p>
            <Button type="button" onClick={() => navigate('login')}>
              Ir para o login
            </Button>
          </section>
        ) : mode === 'register' && inviteLoading ? (
          <p style={{ color: 'var(--color-on-surface-variant, #64748b)', margin: '2rem 0' }}>Validando convite…</p>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            {mfa?.mode === 'enrollment' && (
              <div className="auth-mfa-setup">
                <p>Adicione uma conta TOTP no seu aplicativo autenticador usando esta chave:</p>
                <code>{mfa.manualKey}</code>
              </div>
            )}
            {mfa ? (
              <Field label="Código de verificação" name="code" autoComplete="one-time-code" maxLength={24} inputMode="text" />
            ) : (
              <>
                {mode === 'register' && inviteInfo?.email ? (
                  <Field label="E-mail" name="email" type="email" defaultValue={inviteInfo.email} readOnly required={false} />
                ) : mode !== 'reset' ? (
                  <Field label="E-mail" name="email" type="email" autoComplete="email" />
                ) : null}

                {(mode === 'login' || mode === 'register' || mode === 'reset') && (
                  <Field
                    label={mode === 'reset' ? 'Nova senha' : mode === 'register' ? 'Defina sua senha' : 'Senha'}
                    name="password"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={12}
                  />
                )}
              </>
            )}
            {error && <p className="auth-message auth-message--error" role="alert">{error}</p>}
            {message && <p className="auth-message" role="status">{message}</p>}
            {(!inviteToken && mode === 'register') ? null : (
              <Button type="submit" loading={busy} disabled={mode === 'register' && !inviteInfo && !error}>
                {mfa ? 'Verificar código' : mode === 'login' ? 'Entrar' : mode === 'register' ? 'Criar minha conta' : mode === 'forgot' ? 'Enviar instruções' : 'Redefinir senha'}
              </Button>
            )}
          </form>
        )}

        {!recovery && (
          <nav className="auth-links" aria-label="Opções de acesso">
            {mfa ? (
              <a href="#login" onClick={() => navigate('login')}>Cancelar e voltar</a>
            ) : mode === 'login' ? (
              <a href="#forgot-password" onClick={() => navigate('forgot')}>Esqueci minha senha</a>
            ) : (
              <a href="#login" onClick={() => navigate('login')}>Voltar para o login</a>
            )}
          </nav>
        )}
      </section>
      <aside className="auth-aside" aria-label="Sobre o ClinicFlow">
        <p>Gestão clínica integrada</p>
        <h2>Sua rotina organizada, com cada clínica no lugar certo.</h2>
        <span>Agenda, clientes e operação protegidos pelo seu acesso.</span>
      </aside>
    </main>
  )
}
