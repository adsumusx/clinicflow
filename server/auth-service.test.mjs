// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AuthService, ServiceError } from './auth-service.mjs'
import {
  encryptMfaSecret,
  generateTotpCode,
  hashPassword,
  parseMfaEncryptionKey,
} from './security.mjs'

const mfaEncryptionKey = 'Y2xpbmljZmxvdy1sb2NhbC1tZmEta2V5LTMyLWJ5dGU'
const parsedMfaKey = parseMfaEncryptionKey(mfaEncryptionKey)

function authService(repo, options = {}) {
  return new AuthService(repo, { mfaEncryptionKey, ...options })
}

function repository(overrides = {}) {
  return {
    createSession: vi.fn(async () => {}),
    createMfaChallenge: vi.fn(async () => 'challenge-a'),
    getPreferredOrganizationId: vi.fn(async () => 'org-a'),
    getSession: vi.fn(async () => ({
      user: { id: 'user-a', email: 'ana@example.com' },
      organizationId: 'org-a',
      organizations: [{
        id: 'org-a',
        name: 'Clínica A',
        roleCode: 'owner',
        roleName: 'Proprietário',
        permissions: [
          'memberships.read', 'memberships.manage', 'roles.manage_privileged', 'audit.read',
          'clients.read', 'clients.manage', 'prospects.read', 'prospects.manage',
          'resources.read', 'resources.manage',
        ],
      }],
      expiresAt: new Date(Date.now() + 60_000),
    })),
    ...overrides,
  }
}

describe('AuthService', () => {
  it('cadastra com convite válido e senha derivada sem exigir MFA', async () => {
    const repo = repository({
      registerAccountViaInvite: vi.fn(async () => ({ userId: 'user-a', organizationId: 'org-a' })),
    })
    const service = authService(repo)

    const result = await service.register({
      inviteToken: 'convite-valido-123',
      email: ' ANA@Example.com ',
      password: 'uma senha segura 123',
    })

    expect(repo.registerAccountViaInvite).toHaveBeenCalledWith(expect.objectContaining({
      email: 'ana@example.com',
      inviteTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      passwordHash: expect.stringMatching(/^scrypt\$/),
    }))
    expect(repo.createSession).toHaveBeenCalledOnce()
    expect(repo.createMfaChallenge).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'authenticated',
      token: expect.any(String),
      session: expect.objectContaining({
        user: { id: 'user-a', email: 'ana@example.com' },
      }),
    })
  })

  it('rejeita cadastro sem convite de uma companhia', async () => {
    const repo = repository()
    const service = authService(repo)

    await expect(service.register({
      email: 'ana@example.com',
      password: 'uma senha segura 123',
    })).rejects.toMatchObject({
      status: 403,
      code: 'INVITE_REQUIRED',
    })
  })

  it('gera convite com token e link de cadastro', async () => {
    const repo = repository({
      inviteMember: vi.fn(async () => ({ id: 'mem-1', status: 'invited' })),
    })
    const service = authService(repo)

    const result = await service.inviteMember('session-token', 'org-a', {
      email: 'novo.membro@example.com',
      roleCode: 'professional',
    })

    expect(repo.inviteMember).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      email: 'novo.membro@example.com',
      roleCode: 'professional',
      inviteTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inviteTokenCiphertext: expect.any(String),
    }))
    expect(result).toMatchObject({
      id: 'mem-1',
      status: 'invited',
      token: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      inviteUrl: expect.stringContaining('#register?invite='),
    })
  })

  it('consulta dados públicos de um convite pendente', async () => {
    const repo = repository({
      getInvitationByToken: vi.fn(async () => ({
        id: 'inv-1',
        organization_name: 'Clínica Alfa',
        role_name: 'Profissional',
        role_code: 'professional',
        email_normalized: 'convidado@example.com',
        expires_at: new Date('2026-11-01T12:00:00Z'),
      })),
    })
    const service = authService(repo)

    const result = await service.lookupInvitation('token-convite')
    expect(result).toEqual({
      valid: true,
      organizationName: 'Clínica Alfa',
      roleName: 'Profissional',
      roleCode: 'professional',
      email: 'convidado@example.com',
      expiresAt: new Date('2026-11-01T12:00:00Z'),
    })
  })

  it('não diferencia conta ausente de senha incorreta no login', async () => {
    const passwordHash = await hashPassword('senha correta 123')
    const missing = authService(repository({ findCredentialByEmail: vi.fn(async () => null) }))
    const wrong = authService(repository({
      findCredentialByEmail: vi.fn(async () => ({
        userId: 'user-a', status: 'active', passwordHash, organizationId: 'org-a',
      })),
    }))

    const capture = async (promise) => {
      try {
        await promise
      } catch (error) {
        return error
      }
    }
    const missingError = await capture(missing.login({ email: 'ninguem@example.com', password: 'senha errada 123' }))
    const wrongError = await capture(wrong.login({ email: 'ana@example.com', password: 'senha errada 123' }))

    expect(missingError).toBeInstanceOf(ServiceError)
    expect(wrongError).toBeInstanceOf(ServiceError)
    expect({ status: missingError.status, code: missingError.code, message: missingError.message }).toEqual({
      status: wrongError.status, code: wrongError.code, message: wrongError.message,
    })
  })

  it('responde a recuperação de forma idêntica e só notifica conta ativa', async () => {
    const notify = vi.fn(async () => {})
    const activeRepo = repository({
      findUserByEmail: vi.fn(async () => ({ userId: 'user-a', status: 'active' })),
      createPasswordReset: vi.fn(async () => {}),
    })
    const missingRepo = repository({ findUserByEmail: vi.fn(async () => null) })
    const active = authService(activeRepo, { notifyPasswordReset: notify })
    const missing = authService(missingRepo, { notifyPasswordReset: notify })

    const activeResponse = await active.requestPasswordReset({ email: 'ana@example.com' })
    const missingResponse = await missing.requestPasswordReset({ email: 'ninguem@example.com' })

    expect(activeResponse).toEqual(missingResponse)
    expect(activeRepo.createPasswordReset).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('nega a seleção de organização sem membership ativa', async () => {
    const repo = repository({ selectOrganization: vi.fn(async () => false) })
    const service = authService(repo)

    await expect(service.selectOrganization('session-token', 'org-b')).rejects.toMatchObject({
      status: 403,
      code: 'ORGANIZATION_FORBIDDEN',
    })
  })

  it('revoga todas as sessões depois de consumir uma recuperação', async () => {
    const repo = repository({ consumePasswordReset: vi.fn(async () => true) })
    const service = authService(repo)

    await expect(service.resetPassword({ token: 'valid-reset-token', password: 'nova senha segura 123' }))
      .resolves.toMatchObject({ message: expect.stringContaining('Senha redefinida') })
    expect(repo.consumePasswordReset).toHaveBeenCalledWith(expect.objectContaining({
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      passwordHash: expect.stringMatching(/^scrypt\$/),
    }))
  })

  it('nega por padrão quando a função não possui a permissão exigida', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'org-a',
        organizations: [{
          id: 'org-a', name: 'Clínica A', roleCode: 'professional', roleName: 'Profissional', permissions: [],
        }],
      })),
      listMemberships: vi.fn(),
    })
    const service = authService(repo)

    await expect(service.listMemberships('session-token', 'org-a')).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    })
    expect(repo.listMemberships).not.toHaveBeenCalled()
  })

  it('deriva a organização operacional da seleção da sessão', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'org-a',
        organizations: [
          { id: 'org-a', permissions: ['memberships.read'] },
          { id: 'org-b', permissions: ['memberships.read'] },
        ],
      })),
      listMemberships: vi.fn(),
    })
    const service = authService(repo)

    await expect(service.listMemberships('session-token', 'org-b')).rejects.toMatchObject({
      status: 403,
      code: 'ORGANIZATION_FORBIDDEN',
    })
    expect(repo.listMemberships).not.toHaveBeenCalled()
  })

  it('exige permissão adicional para atribuir papel privilegiado', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['memberships.manage'] }],
      })),
      inviteMember: vi.fn(),
    })
    const service = authService(repo)

    await expect(service.inviteMember('session-token', 'org-a', {
      email: 'admin@example.com', roleCode: 'admin',
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(repo.inviteMember).not.toHaveBeenCalled()
  })

  it('consulta auditoria com filtros validados e cursor opaco', async () => {
    const occurredAt = new Date('2026-09-01T12:00:00.000Z')
    const repo = repository({
      listAuditEvents: vi.fn(async () => ({
        events: [{
          id: 'aaaaaaaa-8100-4000-8000-000000000001',
          actorMembershipId: 'aaaaaaaa-3000-4000-8000-000000000001',
          action: 'membership.invited',
          targetType: 'membership',
          targetId: 'aaaaaaaa-3000-4000-8000-000000000004',
          minimalMetadata: { roleCode: 'professional' },
          occurredAt,
        }],
        next: { id: 'aaaaaaaa-8100-4000-8000-000000000001', occurredAt },
      })),
    })
    const service = authService(repo)

    const first = await service.listAuditEvents('session-token', 'org-a', {
      limit: '25', action: 'membership.invited', targetType: 'membership',
    })
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(repo.listAuditEvents).toHaveBeenLastCalledWith(expect.objectContaining({
      actorUserId: 'user-a', organizationId: 'org-a', limit: 25,
      action: 'membership.invited', targetType: 'membership', cursor: null,
    }))

    await service.listAuditEvents('session-token', 'org-a', { cursor: first.nextCursor })
    expect(repo.listAuditEvents).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: { id: 'aaaaaaaa-8100-4000-8000-000000000001', occurredAt },
    }))
  })

  it('nega consulta da auditoria sem audit.read e rejeita filtros inválidos', async () => {
    const deniedRepo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: [] }],
      })),
      listAuditEvents: vi.fn(),
    })
    const denied = authService(deniedRepo)
    await expect(denied.listAuditEvents('session-token', 'org-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(deniedRepo.listAuditEvents).not.toHaveBeenCalled()

    const service = authService(repository({ listAuditEvents: vi.fn() }))
    await expect(service.listAuditEvents('session-token', 'org-a', { limit: '101' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AUDIT_FILTER' })
    await expect(service.listAuditEvents('session-token', 'org-a', { cursor: 'inválido' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AUDIT_CURSOR' })
  })

  it('não cria sessão privilegiada depois de validar apenas a senha', async () => {
    const passwordHash = await hashPassword('senha correta 123')
    const repo = repository({
      findCredentialByEmail: vi.fn(async () => ({
        userId: 'user-a', status: 'active', passwordHash, organizationId: 'org-a',
        requiresMfa: true, mfaEnrolled: true,
      })),
    })
    const service = authService(repo)

    const result = await service.login({ email: 'ana@example.com', password: 'senha correta 123' })

    expect(result).toMatchObject({ status: 'mfa_required', mfa: { mode: 'authentication' } })
    expect(result.mfa).not.toHaveProperty('manualKey')
    expect(repo.createSession).not.toHaveBeenCalled()
  })

  it('conclui o cadastro TOTP, impede replay no repositório e entrega recuperação uma vez', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const encrypted = encryptMfaSecret(secret, parsedMfaKey)
    const code = generateTotpCode(secret)
    const repo = repository({
      getMfaChallenge: vi.fn(async () => ({
        id: 'challenge-a', userId: 'user-a', purpose: 'enrollment', email: 'ana@example.com',
        factorId: null, secretEncrypted: encrypted, lastUsedStep: null,
      })),
      completeMfaEnrollment: vi.fn(async () => true),
      recordMfaFailure: vi.fn(),
    })
    const service = authService(repo)

    const result = await service.verifyMfa({ challengeToken: 'challenge-token', code })

    expect(repo.completeMfaEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: 'challenge-a',
      lastUsedStep: expect.any(Number),
      recoveryCodeHashes: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    }))
    expect(result.recoveryCodes).toHaveLength(10)
    expect(new Set(result.recoveryCodes).size).toBe(10)
    expect(repo.createSession).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true }))
  })

  it('contabiliza código TOTP inválido sem criar sessão', async () => {
    const repo = repository({
      getMfaChallenge: vi.fn(async () => ({
        id: 'challenge-a', userId: 'user-a', purpose: 'authentication', factorId: 'factor-a',
        secretEncrypted: encryptMfaSecret('JBSWY3DPEHPK3PXP', parsedMfaKey), lastUsedStep: null,
      })),
      recordMfaFailure: vi.fn(async () => {}),
    })
    const service = authService(repo)

    await expect(service.verifyMfa({ challengeToken: 'challenge-token', code: '000000' }))
      .rejects.toMatchObject({ status: 401, code: 'INVALID_MFA' })
    expect(repo.recordMfaFailure).toHaveBeenCalledWith('challenge-a')
    expect(repo.createSession).not.toHaveBeenCalled()
  })

  it('rejeita a reutilização do mesmo passo TOTP', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const currentStep = Math.floor(Date.now() / 1000 / 30)
    const repo = repository({
      getMfaChallenge: vi.fn(async () => ({
        id: 'challenge-a', userId: 'user-a', purpose: 'authentication', factorId: 'factor-a',
        secretEncrypted: encryptMfaSecret(secret, parsedMfaKey), lastUsedStep: currentStep,
      })),
      completeMfaAuthentication: vi.fn(),
      recordMfaFailure: vi.fn(async () => {}),
    })
    const service = authService(repo)

    await expect(service.verifyMfa({
      challengeToken: 'challenge-token', code: generateTotpCode(secret),
    })).rejects.toMatchObject({ status: 401, code: 'INVALID_MFA' })
    expect(repo.completeMfaAuthentication).not.toHaveBeenCalled()
    expect(repo.recordMfaFailure).toHaveBeenCalledOnce()
  })

  it('consome um código de recuperação e cria sessão com MFA', async () => {
    const repo = repository({
      getMfaChallenge: vi.fn(async () => ({
        id: 'challenge-a', userId: 'user-a', purpose: 'authentication', factorId: 'factor-a',
        secretEncrypted: encryptMfaSecret('JBSWY3DPEHPK3PXP', parsedMfaKey), lastUsedStep: null,
      })),
      consumeMfaRecoveryCode: vi.fn(async () => true),
      recordMfaFailure: vi.fn(),
    })
    const service = authService(repo)

    const result = await service.verifyMfa({
      challengeToken: 'challenge-token', code: 'ABCD-EFGH-IJKL-MNPQ',
    })

    expect(repo.consumeMfaRecoveryCode).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: 'challenge-a', codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(result).toMatchObject({ status: 'authenticated' })
    expect(repo.createSession).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true }))
  })

  it('normaliza e valida o cadastro de cliente antes do repositório', async () => {
    const repo = repository({ createClient: vi.fn(async ({ client }) => ({ id: 'client-a', ...client })) })
    const service = authService(repo)

    await service.createClient('session-token', 'org-a', {
      fullName: '  Ana   da Silva  ',
      clientType: 'fixed',
      birthDate: '1990-02-28',
      documentNumber: 'ABC-12.345',
      contacts: [
        { type: 'email', value: ' ANA@Example.com ', preferred: true },
        { type: 'phone', value: '(47) 99999-0000', preferred: true },
      ],
    })

    expect(repo.createClient).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      organizationId: 'org-a',
      client: {
        fullName: 'Ana da Silva',
        clientType: 'fixed',
        birthDate: '1990-02-28',
        documentNumber: 'ABC12345',
        contacts: [
          { type: 'email', value: 'ana@example.com', normalizedValue: 'ana@example.com', preferred: true },
          { type: 'phone', value: '(47) 99999-0000', normalizedValue: '47999990000', preferred: true },
        ],
      },
    }))
  })

  it('rejeita dados inválidos e duplicidade sem persistir', async () => {
    const repo = repository({ createClient: vi.fn() })
    const service = authService(repo)

    await expect(service.createClient('session-token', 'org-a', {
      fullName: 'A', contacts: [],
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_CLIENT' })
    await expect(service.createClient('session-token', 'org-a', {
      fullName: 'Ana Silva',
      birthDate: '2026-02-30',
      contacts: [],
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_CLIENT' })
    await expect(service.createClient('session-token', 'org-a', {
      fullName: 'Ana Silva',
      clientType: 'legacy',
      contacts: [],
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_CLIENT' })
    await expect(service.createClient('session-token', 'org-a', {
      fullName: 'Ana Silva',
      contacts: [
        { type: 'email', value: 'ana@example.com' },
        { type: 'email', value: ' ANA@example.com ' },
      ],
    })).rejects.toMatchObject({ status: 409, code: 'CLIENT_DUPLICATE' })
    expect(repo.createClient).not.toHaveBeenCalled()
  })

  it('valida e encaminha o filtro fixo/rotativo', async () => {
    const repo = repository({ listClients: vi.fn(async () => ({ items: [], total: 0 })) })
    const service = authService(repo)

    await service.listClients('session-token', 'org-a', { clientType: 'fixed' })
    expect(repo.listClients).toHaveBeenCalledWith({
      actorUserId: 'user-a', organizationId: 'org-a', clientType: 'fixed',
      search: null, contactSearch: null, page: 1, pageSize: 20,
    })
    await expect(service.listClients('session-token', 'org-a', { clientType: 'todos' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CLIENT_FILTER' })
  })

  it('valida busca/paginação e limita o perfil às capacidades da função', async () => {
    const repo = repository({
      listClients: vi.fn(async () => ({ items: [{ id: 'client-a' }], total: 21 })),
      getClientProfile: vi.fn(async ({ sections }) => ({ client: { id: 'client-a' }, access: sections })),
    })
    const service = authService(repo)

    const result = await service.listClients('session-token', 'org-a', {
      search: '  (47) 9999 ', page: '2', pageSize: '10',
    })
    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 21, totalPages: 3 })
    expect(repo.listClients).toHaveBeenCalledWith(expect.objectContaining({
      search: '(47) 9999', contactSearch: '479999', page: 2, pageSize: 10,
    }))
    await expect(service.listClients('session-token', 'org-a', { pageSize: '101' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CLIENT_FILTER' })

    await service.getClientProfile(
      'session-token', 'org-a', 'aaaaaaaa-5000-4000-8000-000000000001',
    )
    expect(repo.getClientProfile).toHaveBeenCalledWith(expect.objectContaining({
      sections: { schedule: false, plan: false, finance: false, history: true, clinical: false },
    }))
  })

  it('nega mutações de clientes sem a permissão granular', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['clients.read'] }],
      })),
      createClient: vi.fn(),
    })
    const service = authService(repo)

    await expect(service.createClient('session-token', 'org-a', {
      fullName: 'Ana Silva', contacts: [],
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(repo.createClient).not.toHaveBeenCalled()
  })

  it('valida permissões e dados para prontuário clínico e registro profissional', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'prof-user' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['clinical.read', 'clinical.write', 'memberships.manage'] }],
      })),
      listClientClinicalRecords: vi.fn(async () => ({ items: [] })),
      createClientClinicalRecord: vi.fn(async ({ content, recordType }) => ({
        id: 'rec-1', recordType, content,
        authorProfessional: { displayName: 'Dra. Ana', registrationNumber: 'CREFITO-3/12345-F' },
      })),
      updateProfessional: vi.fn(async ({ registrationNumber }) => ({
        id: 'prof-1', registrationNumber,
      })),
    })
    const service = authService(repo)

    const list = await service.listClientClinicalRecords('session-token', 'org-a', 'aaaaaaaa-5000-4000-8000-000000000001')
    expect(list).toEqual({ items: [] })

    const created = await service.createClientClinicalRecord('session-token', 'org-a', 'aaaaaaaa-5000-4000-8000-000000000001', {
      content: '  Evolução de fisioterapia  ',
      recordType: 'evolucao',
    })
    expect(created.authorProfessional.registrationNumber).toBe('CREFITO-3/12345-F')

    await expect(service.createClientClinicalRecord('session-token', 'org-a', 'aaaaaaaa-5000-4000-8000-000000000001', {
      content: '   ',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_CLINICAL_CONTENT' })

    const updated = await service.updateProfessional('session-token', 'org-a', 'aaaaaaaa-4000-4000-8000-000000000001', {
      registrationNumber: 'CREFITO-3/99999-F',
    })
    expect(updated.registrationNumber).toBe('CREFITO-3/99999-F')
  })

  it('normaliza a prospecção, seus contatos e a próxima ação', async () => {
    const repo = repository({
      createProspect: vi.fn(async ({ prospect }) => ({ id: 'prospect-a', ...prospect })),
    })
    const service = authService(repo)

    await service.createProspect('session-token', 'org-a', {
      fullName: '  Ana   Interessada ',
      source: '  Indicação  ',
      stage: 'contacted',
      ownerProfessionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
      nextActionAt: '2026-09-10T14:00:00-03:00',
      nextActionNote: '  Confirmar   aula experimental ',
      contacts: [
        { type: 'email', value: ' ANA@Example.com ', preferred: true },
        { type: 'phone', value: '(47) 99999-0000', preferred: true },
      ],
    })

    expect(repo.createProspect).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      organizationId: 'org-a',
      prospect: expect.objectContaining({
        fullName: 'Ana Interessada',
        source: 'Indicação',
        stage: 'contacted',
        nextActionAt: expect.any(Date),
        nextActionNote: 'Confirmar aula experimental',
        contacts: [
          { type: 'email', value: 'ana@example.com', normalizedValue: 'ana@example.com', preferred: true },
          { type: 'phone', value: '(47) 99999-0000', normalizedValue: '47999990000', preferred: true },
        ],
      }),
    }))
  })

  it('valida os filtros, interações e as duas permissões da conversão', async () => {
    const prospectId = 'aaaaaaaa-9000-4000-8000-000000000001'
    const repo = repository({
      listProspects: vi.fn(async () => ({ items: [], owners: [], stageCounts: {}, total: 0 })),
      addProspectInteraction: vi.fn(async ({ interaction }) => ({ id: 'interaction-a', ...interaction })),
      convertProspect: vi.fn(async () => ({ created: true })),
    })
    const service = authService(repo)

    const list = await service.listProspects('session-token', 'org-a', {
      stage: 'qualified', search: ' (47) 9999 ', pageSize: '10',
    })
    expect(list.pagination).toEqual({ page: 1, pageSize: 10, total: 0, totalPages: 0 })
    expect(repo.listProspects).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'qualified', search: '(47) 9999', contactSearch: '479999',
    }))
    await expect(service.listProspects('session-token', 'org-a', { stage: 'invalid' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_PROSPECT_FILTER' })

    await service.addProspectInteraction('session-token', 'org-a', prospectId, {
      type: 'call', notes: 'Confirmou interesse.',
    })
    expect(repo.addProspectInteraction).toHaveBeenCalledWith(expect.objectContaining({
      interaction: expect.objectContaining({ type: 'call', notes: 'Confirmou interesse.' }),
    }))

    await service.convertProspect('session-token', 'org-a', prospectId, { clientType: 'fixed' })
    expect(repo.convertProspect).toHaveBeenCalledWith(expect.objectContaining({
      conversion: { clientType: 'fixed', birthDate: null, documentNumber: null },
    }))

    const deniedRepo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['prospects.read', 'prospects.manage'] }],
      })),
      convertProspect: vi.fn(),
    })
    await expect(authService(deniedRepo).convertProspect('session-token', 'org-a', prospectId, {}))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(deniedRepo.convertProspect).not.toHaveBeenCalled()
  })

  it('valida e normaliza os quatro tipos de recursos operacionais', async () => {
    const repo = repository({
      listResources: vi.fn(async () => ({ modalities: [], services: [], rooms: [], equipment: [], units: [] })),
      createResource: vi.fn(async ({ resource }) => ({ id: 'resource-a', ...resource })),
      updateResource: vi.fn(async ({ resource }) => ({ id: 'aaaaaaaa-6100-4000-8000-000000000001', ...resource })),
    })
    const service = authService(repo)
    await service.listResources('session-token', 'org-a', { status: 'inactive' })
    expect(repo.listResources).toHaveBeenCalledWith({
      actorUserId: 'user-a', organizationId: 'org-a', active: false,
    })

    await service.createResource('session-token', 'org-a', 'services', {
      name: '  Pilates   individual ',
      modalityId: 'aaaaaaaa-6000-4000-8000-000000000001',
      durationMinutes: '50', defaultCapacity: '1', active: true,
    })
    expect(repo.createResource).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'services',
      resource: {
        name: 'Pilates individual', active: true,
        modalityId: 'aaaaaaaa-6000-4000-8000-000000000001',
        durationMinutes: 50, defaultCapacity: 1,
      },
    }))
    await service.updateResource(
      'session-token', 'org-a', 'equipment', 'aaaaaaaa-6250-4000-8000-000000000001',
      { name: 'Reformer', unitId: 'aaaaaaaa-1000-4000-8000-000000000001', quantity: 4, active: false },
    )
    expect(repo.updateResource).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'equipment', resource: expect.objectContaining({ quantity: 4, active: false }),
    }))

    await expect(service.createResource('session-token', 'org-a', 'rooms', {
      name: 'Sala', unitId: 'inválida', capacity: 2,
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_RESOURCE_REFERENCE' })
    await expect(service.createResource('session-token', 'org-a', 'equipment', {
      name: 'A', unitId: 'aaaaaaaa-1000-4000-8000-000000000001', quantity: 0,
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_RESOURCE' })
  })

  it('normaliza disponibilidade e agendamento com fuso explícito', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.read', 'schedule.manage'] }],
      })),
      createAvailability: vi.fn(async ({ availability }) => ({ id: 'rule-a', ...availability })),
      createAppointment: vi.fn(async ({ appointment }) => ({ id: 'appointment-a', ...appointment })),
      getSchedule: vi.fn(async () => ({ appointments: [] })),
    })
    const service = authService(repo)
    const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
    const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
    const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'

    await service.createAvailability('session-token', 'org-a', {
      professionalId, unitId, kind: 'break', weekday: 2,
      localStartTime: '12:00', localEndTime: '13:00',
      timezone: 'America/Sao_Paulo', label: 'Intervalo de almoço',
    })
    expect(repo.createAvailability).toHaveBeenCalledWith(expect.objectContaining({
      availability: expect.objectContaining({
        kind: 'break', weekday: 2, startsAt: null, endsAt: null, active: true,
      }),
    }))

    await service.createAppointment('session-token', 'org-a', {
      professionalId, unitId, serviceId, clientId, roomId: null,
      startsAt: '2026-09-08T10:00:00-03:00',
    })
    expect(repo.createAppointment).toHaveBeenCalledWith(expect.objectContaining({
      appointment: expect.objectContaining({ startsAt: expect.any(Date), roomId: null }),
    }))

    await service.getSchedule('session-token', 'org-a', {
      from: '2026-09-01T00:00:00-03:00', to: '2026-10-01T00:00:00-03:00',
    })
    expect(repo.getSchedule).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.any(Date), to: expect.any(Date), professionalId: null,
    }))

    await expect(service.createAppointment('session-token', 'org-a', {
      professionalId, unitId, serviceId, clientId, startsAt: '2026-09-08T10:00:00',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_APPOINTMENT' })
    await expect(service.createAvailability('session-token', 'org-a', {
      professionalId, unitId, kind: 'vacation',
      startsAt: '2026-09-10T10:00:00-03:00', endsAt: '2026-09-09T10:00:00-03:00',
      timezone: 'America/Sao_Paulo',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_AVAILABILITY' })
  })

  it('traduz conflitos da agenda sem expor erro do banco', async () => {
    const conflict = Object.assign(new Error('appointment outside professional availability'), { code: '23P01' })
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.read', 'schedule.manage'] }],
      })),
      createAppointment: vi.fn(async () => { throw conflict }),
    })
    const service = authService(repo)
    await expect(service.createAppointment('session-token', 'org-a', {
      professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
      unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
      serviceId: 'aaaaaaaa-6100-4000-8000-000000000001',
      clientId: 'aaaaaaaa-5000-4000-8000-000000000001',
      startsAt: '2026-09-08T12:00:00-03:00',
    })).rejects.toMatchObject({ status: 409, code: 'OUTSIDE_AVAILABILITY' })
  })

  it('normaliza turmas e preserva o horário local da recorrência após mudança de fuso', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.manage'] }],
      })),
      createClassAppointment: vi.fn(async ({ appointment }) => appointment),
      createAppointmentSeries: vi.fn(async ({ series }) => series),
    })
    const service = authService(repo)
    const common = {
      professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
      unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
      serviceId: 'aaaaaaaa-6100-4000-8000-000000000001',
      roomId: null,
    }
    await service.createClassAppointment('session-token', 'org-a', {
      ...common, startsAt: '2026-10-20T10:00:00-03:00', capacity: 3,
      clientIds: ['aaaaaaaa-5000-4000-8000-000000000001'],
    })
    expect(repo.createClassAppointment).toHaveBeenCalledWith(expect.objectContaining({
      appointment: expect.objectContaining({ capacity: 3, clientIds: expect.any(Array) }),
    }))

    await service.createAppointmentSeries('session-token', 'org-a', {
      ...common,
      clientId: 'aaaaaaaa-5000-4000-8000-000000000001',
      startsAt: '2026-10-25T09:00:00-04:00',
      recurrence: { frequency: 'weekly', interval: 1, count: 3, timezone: 'America/New_York' },
    })
    const normalized = repo.createAppointmentSeries.mock.calls[0][0].series
    expect(normalized.occurrences).toEqual([
      new Date('2026-10-25T13:00:00.000Z'),
      new Date('2026-11-01T14:00:00.000Z'),
      new Date('2026-11-08T14:00:00.000Z'),
    ])
  })

  it('traduz lotação concorrente em conflito de capacidade', async () => {
    const full = Object.assign(new Error('appointment capacity exceeded'), { code: '23514' })
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.manage'] }],
      })),
      addAppointmentParticipant: vi.fn(async () => { throw full }),
    })
    await expect(authService(repo).addAppointmentParticipant(
      'session-token', 'org-a', 'aaaaaaaa-6300-4000-8000-000000000001',
      { clientId: 'aaaaaaaa-5000-4000-8000-000000000001' },
    )).rejects.toMatchObject({ status: 409, code: 'CAPACITY_EXCEEDED' })
  })

  it('autoriza a área e o check-in apenas pelas capacidades próprias da sessão', async () => {
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{
          id: 'org-a', roleCode: 'client',
          permissions: ['clients.own.read', 'schedule.own.read', 'schedule.own.manage', 'clinical.published.read'],
        }],
      })),
      getClientArea: vi.fn(async () => ({ client: { id: 'client-a' } })),
      getOwnPublishedClinicalContent: vi.fn(async () => ({ assessments: [], workoutPlans: [] })),
      getOwnContactChannels: vi.fn(async () => ({ channels: [] })),
      getOwnAppointments: vi.fn(async () => ({ appointments: [] })),
      selfCheckIn: vi.fn(async () => ({ id: appointmentId, checkedInAt: new Date() })),
    })
    const service = authService(repo)

    await service.getClientArea('session-token', 'org-a')
    await service.getOwnPublishedClinicalContent('session-token', 'org-a')
    await service.getOwnContactChannels('session-token', 'org-a')
    await service.getOwnAppointments('session-token', 'org-a')
    await service.selfCheckIn('session-token', 'org-a', appointmentId)

    expect(repo.getClientArea).toHaveBeenCalledWith({ actorUserId: 'client-user', organizationId: 'org-a' })
    expect(repo.getOwnPublishedClinicalContent).toHaveBeenCalledWith({ actorUserId: 'client-user', organizationId: 'org-a' })
    expect(repo.getOwnContactChannels).toHaveBeenCalledWith({ actorUserId: 'client-user', organizationId: 'org-a' })
    expect(repo.getOwnAppointments).toHaveBeenCalledWith({ actorUserId: 'client-user', organizationId: 'org-a' })
    expect(repo.selfCheckIn).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })
  })

  it('nega conteúdo clínico publicado quando a capacidade própria foi removida', async () => {
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', roleCode: 'client', permissions: ['clients.own.read'] }],
      })),
      getOwnPublishedClinicalContent: vi.fn(),
    })
    await expect(authService(repo).getOwnPublishedClinicalContent('session-token', 'org-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(repo.getOwnPublishedClinicalContent).not.toHaveBeenCalled()
  })

  it('autoriza interesse próprio e avanço profissional com capacidades distintas', async () => {
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{
          id: 'org-a', permissions: ['schedule.own.read', 'schedule.own.manage', 'schedule.manage'],
        }],
      })),
      getOwnWaitlist: vi.fn(async () => ({ entries: [], eligibleAppointments: [] })),
      joinOwnWaitlist: vi.fn(async () => ({ id: 'entry-a' })),
      leaveOwnWaitlist: vi.fn(async () => ({ id: 'entry-a', status: 'cancelled' })),
      confirmOwnWaitlistOffer: vi.fn(async () => ({ participantId: 'participant-a' })),
      advanceWaitlistOffer: vi.fn(async () => ({ id: 'offer-a' })),
    })
    const service = authService(repo)

    await service.getOwnWaitlist('session-token', 'org-a')
    await service.joinOwnWaitlist('session-token', 'org-a', appointmentId)
    await service.leaveOwnWaitlist('session-token', 'org-a', appointmentId)
    await service.confirmOwnWaitlistOffer('session-token', 'org-a', appointmentId)
    await service.advanceWaitlistOffer('session-token', 'org-a', appointmentId)

    expect(repo.getOwnWaitlist).toHaveBeenCalledWith({ actorUserId: 'client-user', organizationId: 'org-a' })
    expect(repo.joinOwnWaitlist).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })
    expect(repo.leaveOwnWaitlist).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })
    expect(repo.confirmOwnWaitlistOffer).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })
    expect(repo.advanceWaitlistOffer).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })
  })

  it('valida emissão e autoriza uso próprio de reposição sem aceitar identidade do navegador', async () => {
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const sourceParticipantId = 'aaaaaaaa-6400-4000-8000-000000000001'
    const repo = repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{
          id: 'org-a', permissions: [
            'clients.read', 'schedule.manage', 'schedule.own.read', 'schedule.own.manage',
          ],
        }],
      })),
      issueReplacementCredit: vi.fn(async (input) => ({ id: 'credit-a', ...input })),
      getOwnReplacementCredits: vi.fn(async () => ({ balance: 1, credits: [] })),
      bookOwnAppointmentWithReplacement: vi.fn(async () => ({ id: appointmentId })),
    })
    const service = authService(repo)

    await service.issueReplacementCredit('session-token', 'org-a', clientId, {
      sourceParticipantId, expiresOn: '2026-10-15',
    })
    await service.getOwnReplacementCredits('session-token', 'org-a')
    await service.bookOwnAppointmentWithReplacement('session-token', 'org-a', appointmentId)

    expect(repo.issueReplacementCredit).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', clientId,
      sourceParticipantId, expiresOn: '2026-10-15',
    })
    expect(repo.getOwnReplacementCredits).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a',
    })
    expect(repo.bookOwnAppointmentWithReplacement).toHaveBeenCalledWith({
      actorUserId: 'client-user', organizationId: 'org-a', appointmentId,
    })

    await expect(service.issueReplacementCredit('session-token', 'org-a', clientId, {
      sourceParticipantId, expiresOn: '15/10/2026',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_REPLACEMENT_EXPIRATION' })
  })

  it('nega check-in sem capacidade própria e rejeita identificador inválido', async () => {
    const withoutPermission = authService(repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.own.read'] }],
      })),
    }))
    await expect(withoutPermission.selfCheckIn(
      'session-token', 'org-a', 'aaaaaaaa-6300-4000-8000-000000000001',
    )).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    const invalidId = authService(repository({
      getSession: vi.fn(async () => ({
        user: { id: 'client-user' }, organizationId: 'org-a',
        organizations: [{ id: 'org-a', permissions: ['schedule.own.manage'] }],
      })),
    }))
    await expect(invalidId.selfCheckIn('session-token', 'org-a', 'appointment-a'))
      .rejects.toMatchObject({ status: 404, code: 'APPOINTMENT_NOT_FOUND' })
  })

  it('registra o token push cifrado e permite revogar somente dispositivo próprio', async () => {
    const repo = repository({
      registerPushDevice: vi.fn(async (device) => ({ id: 'device-a', platform: device.platform })),
      revokePushDevice: vi.fn(async () => true),
    })
    const service = authService(repo)
    const rawToken = 'fcm-token-owned-by-this-device-123456'

    await service.registerPushDevice('session-token', { platform: 'android', token: rawToken })

    const registered = repo.registerPushDevice.mock.calls[0][0]
    expect(registered).toMatchObject({
      userId: 'user-a', platform: 'android', tokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(registered.tokenCiphertext).not.toContain(rawToken)
    await service.revokePushDevice(
      'session-token', 'aaaaaaaa-9000-4000-8000-000000000001',
    )
    expect(repo.revokePushDevice).toHaveBeenCalledWith({
      userId: 'user-a', deviceId: 'aaaaaaaa-9000-4000-8000-000000000001',
    })
  })

  it('aplica preferências push somente à própria organização e aos eventos suportados', async () => {
    const repo = repository({
      listNotificationPreferences: vi.fn(async () => [
        { eventType: 'waitlist.offer.created', enabled: true },
      ]),
      updateNotificationPreference: vi.fn(async ({ eventType, enabled }) => ({ eventType, enabled })),
    })
    const service = authService(repo)

    expect(await service.listNotificationPreferences('session-token', 'org-a')).toEqual({
      channel: 'push', preferences: [{ eventType: 'waitlist.offer.created', enabled: true }],
    })
    await service.updateNotificationPreference('session-token', 'org-a', {
      eventType: 'waitlist.offer.created', enabled: false,
    })
    expect(repo.updateNotificationPreference).toHaveBeenCalledWith({
      userId: 'user-a', organizationId: 'org-a',
      eventType: 'waitlist.offer.created', enabled: false,
    })
    await expect(service.updateNotificationPreference('session-token', 'org-a', {
      eventType: 'client.private_data.changed', enabled: true,
    })).rejects.toMatchObject({ code: 'INVALID_NOTIFICATION_PREFERENCE' })
  })
})

describe('relatórios', () => {
  function reportsRepository(overrides = {}) {
    return repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'aaaaaaaa-0000-4000-8000-000000000001',
        organizations: [{
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          name: 'Clínica A',
          roleCode: 'owner',
          roleName: 'Proprietário',
          permissions: ['reports.read'],
        }],
        expiresAt: new Date(Date.now() + 60_000),
      })),
      ...overrides,
    })
  }

  it('valida e encaminha os filtros compartilhados do relatório', async () => {
    const listBirthdayReport = vi.fn(async () => ({ items: [], total: 0 }))
    const service = authService(reportsRepository({ listBirthdayReport }))

    const result = await service.listBirthdayReport(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      {
        from: '2026-09-01',
        to: '2026-09-30',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        status: 'active',
        page: '2',
        pageSize: '10',
      },
    )

    expect(listBirthdayReport).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-09-01', to: '2026-09-30', status: 'active', page: 2, pageSize: 10,
    }))
    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 0, totalPages: 0 })
  })

  it('rejeita período invertido antes de consultar o repositório', async () => {
    const listBirthdayReport = vi.fn()
    const service = authService(reportsRepository({ listBirthdayReport }))

    await expect(service.listBirthdayReport(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-10-01', to: '2026-09-01' },
    )).rejects.toMatchObject({ status: 400, code: 'INVALID_REPORT_FILTER' })
    expect(listBirthdayReport).not.toHaveBeenCalled()
  })

  it('exporta CSV sem permitir fórmula e sem inventar contato não autorizado', async () => {
    const listBirthdayReport = vi.fn(async () => ({
      total: 2,
      items: [
        {
          clientId: 'client-a', fullName: '=2+2', birthDate: '1990-09-03',
          occursOn: '2026-09-03', status: 'active', contactAllowed: false,
          preferredContact: null,
        },
        {
          clientId: 'client-b', fullName: 'Bia', birthDate: '1991-09-04',
          occursOn: '2026-09-04', status: 'active', contactAllowed: true,
          preferredContact: { type: 'email', value: 'bia@example.invalid' },
        },
      ],
    }))
    const service = authService(reportsRepository({ listBirthdayReport }))

    const result = await service.exportBirthdayReport(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30' },
    )

    expect(result.filename).toBe('aniversariantes-2026-09-01-2026-09-30.csv')
    expect(result.content).toContain("\"'=2+2\"")
    expect(result.content).toContain('"Não";"";""')
    expect(result.content).toContain('"Sim";"email";"bia@example.invalid"')
  })

  it('mantém os totais do relatório de clientes na mesma base dos detalhes', async () => {
    const listClientReport = vi.fn(async () => ({
      totals: { total: 1, fixed: 1, rotating: 0, active: 1, inactive: 0 },
      items: [{ clientId: 'client-a', fullName: 'Ana', clientType: 'fixed', status: 'active' }],
    }))
    const service = authService(reportsRepository({ listClientReport }))

    const result = await service.listClientReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30', clientType: 'fixed', page: '2', pageSize: '10' },
    )

    expect(listClientReport).toHaveBeenCalledWith(expect.objectContaining({
      clientType: 'fixed', page: 2, pageSize: 10,
    }))
    expect(result.totals.total).toBe(result.pagination.total)
  })

  it('valida o agrupamento e o período do drill-down de atividade', async () => {
    const listClientActivityReport = vi.fn(async () => ({
      items: [], details: [], detailTotal: 0,
    }))
    const service = authService(reportsRepository({ listClientActivityReport }))

    await service.listClientActivityReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-01-01', to: '2026-12-31', granularity: 'month', bucket: '2026-09' },
    )
    expect(listClientActivityReport).toHaveBeenCalledWith(expect.objectContaining({
      granularity: 'month', bucket: '2026-09',
    }))
    await expect(service.listClientActivityReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-01-01', to: '2026-12-31', granularity: 'month', bucket: '2027-01' },
    )).rejects.toMatchObject({ code: 'INVALID_REPORT_FILTER' })
  })

  it('mantém dashboard e CSV sobre os mesmos indicadores conciliados', async () => {
    const dashboard = {
      financial: { billedCents: 25000, receivedCents: 15000, outstandingCents: 10000 },
      operational: {
        appointments: 2, completedAppointments: 1, attendances: 3, absences: 1,
        attendanceRate: 75,
      },
    }
    const getBusinessDashboardReport = vi.fn(async () => dashboard)
    const service = authService(reportsRepository({ getBusinessDashboardReport }))

    const result = await service.getBusinessDashboardReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30', status: 'active' },
    )
    const exported = await service.exportBusinessDashboardReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30', status: 'active' },
    )

    expect(result).toMatchObject(dashboard)
    expect(getBusinessDashboardReport).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-09-01', to: '2026-09-30', status: 'active',
    }))
    expect(exported.content).toContain('"Recebido líquido";"15000"')
    expect(exported.content).toContain('"Taxa de presença";"75"')
  })

  it('valida modalidade e limita a exportação de aparelhos', async () => {
    const listEquipmentUsageReport = vi.fn(async () => ({
      items: [], total: 0,
      totals: { equipmentTypes: 0, appointments: 0, allocatedQuantity: 0 },
    }))
    const service = authService(reportsRepository({ listEquipmentUsageReport }))

    await service.listEquipmentUsageReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      {
        from: '2026-09-01', to: '2026-09-30',
        modalityId: 'aaaaaaaa-6000-4000-8000-000000000001', page: '2', pageSize: '10',
      },
    )
    expect(listEquipmentUsageReport).toHaveBeenCalledWith(expect.objectContaining({
      modalityId: 'aaaaaaaa-6000-4000-8000-000000000001', page: 2, pageSize: 10,
    }))
    await expect(service.listEquipmentUsageReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30', modalityId: 'invalida' },
    )).rejects.toMatchObject({ code: 'INVALID_REPORT_FILTER' })
  })

  it('calcula o funil de prospecções e exporta o mesmo detalhe com CSV seguro', async () => {
    const prospectResult = {
      totals: {
        total: 3, converted: 1, lost: 1, open: 1,
        conversionRate: 33.3, lossRate: 33.3, averageCycleDays: 4.5,
      },
      stages: { new: 0, contacted: 0, qualified: 0, proposal: 1, lost: 1, converted: 1 },
      sources: [{ source: 'Indicação', total: 3, converted: 1, lost: 1, conversionRate: 33.3 }],
      items: [{
        prospectId: 'prospect-a', fullName: '=Nome', source: 'Indicação', stage: 'converted',
        ownerDisplayName: 'Carla', createdOn: '2026-09-01', closedOn: '2026-09-05', cycleDays: 4,
      }],
    }
    const listProspectReport = vi.fn(async () => prospectResult)
    const service = authService(reportsRepository({ listProspectReport }))

    const result = await service.listProspectReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      {
        from: '2026-09-01', to: '2026-09-30',
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001', page: '2', pageSize: '10',
      },
    )
    const exported = await service.exportProspectReport(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001',
      { from: '2026-09-01', to: '2026-09-30' },
    )

    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 3, totalPages: 1 })
    expect(listProspectReport).toHaveBeenCalledWith(expect.objectContaining({
      professionalId: 'aaaaaaaa-4000-4000-8000-000000000001', page: 2, pageSize: 10,
    }))
    expect(exported.filename).toBe('prospeccoes-2026-09-01-2026-09-30.csv')
    expect(exported.content).toContain("\"'=Nome\"")
    expect(exported.content).toContain('"Convertida"')
  })
})

describe('contas a receber', () => {
  const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
  const categoryId = 'aaaaaaaa-7100-4000-8000-000000000001'
  const receivableId = 'aaaaaaaa-7300-4000-8000-000000000001'
  function financeRepository(overrides = {}) {
    return repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'org-a',
        organizations: [{
          id: 'org-a', name: 'Clínica A', roleCode: 'owner', roleName: 'Proprietário',
          permissions: ['finance.read', 'finance.manage'],
        }],
        expiresAt: new Date(Date.now() + 60_000),
      })),
      ...overrides,
    })
  }

  it('normaliza uma recorrência mensal antes de persistir', async () => {
    const repo = financeRepository({
      createReceivable: vi.fn(async ({ receivable }) => ({ items: [receivable] })),
    })
    const service = authService(repo)
    await service.createReceivable('token', 'org-a', {
      description: '  Mensalidade de Pilates  ', clientId, categoryId,
      amountCents: 25000, dueOn: '2026-09-30', competenceOn: '2026-09-01',
      idempotencyKey: 'web:finance:test-001',
      recurrence: { frequency: 'monthly', installmentCount: 12 },
    })

    expect(repo.createReceivable).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      receivable: {
        description: 'Mensalidade de Pilates', clientId, categoryId,
        amountCents: 25000, currency: 'BRL', dueOn: '2026-09-30',
        competenceOn: '2026-09-01', idempotencyKey: 'web:finance:test-001',
        recurrence: { frequency: 'monthly', installmentCount: 12 },
      },
    }))
  })

  it('rejeita valor inválido e cancelamento sem motivo', async () => {
    const service = authService(financeRepository())
    await expect(service.createReceivable('token', 'org-a', {
      description: 'Mensalidade', clientId, categoryId, amountCents: 0,
      dueOn: '2026-09-10', idempotencyKey: 'web:finance:test-002',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_RECEIVABLE' })
    await expect(service.cancelReceivable('token', 'org-a', receivableId, { reason: '' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CANCELLATION' })
  })

  it('normaliza recebimentos, estornos e despesas recorrentes', async () => {
    const paymentId = 'aaaaaaaa-7400-4000-8000-000000000001'
    const payableId = 'aaaaaaaa-7500-4000-8000-000000000001'
    const repo = financeRepository({
      createReceivablePayment: vi.fn(async ({ payment }) => ({ payment })),
      reverseReceivablePayment: vi.fn(async ({ reversal }) => ({ payment: reversal })),
      createPayable: vi.fn(async ({ payable }) => ({ items: [payable] })),
    })
    const service = authService(repo)
    await service.createReceivablePayment('token', 'org-a', receivableId, {
      amountCents: 12500, method: 'pix', paidAt: '2026-09-03T12:30:00-03:00',
      externalReference: ' PIX-001 ', idempotencyKey: 'web:payment:001',
    })
    expect(repo.createReceivablePayment).toHaveBeenCalledWith(expect.objectContaining({
      payment: {
        amountCents: 12500, method: 'pix', paidAt: '2026-09-03T15:30:00.000Z',
        externalReference: 'PIX-001', idempotencyKey: 'web:payment:001',
      },
    }))
    await service.reverseReceivablePayment('token', 'org-a', receivableId, paymentId, {
      reason: ' Lançamento duplicado ', reversedAt: '2026-09-04T09:00:00Z',
      idempotencyKey: 'web:reversal:001',
    })
    expect(repo.reverseReceivablePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentId, reversal: expect.objectContaining({ reason: 'Lançamento duplicado' }),
    }))
    await service.createPayable('token', 'org-a', {
      counterparty: ' Fornecedor A ', description: ' Aluguel ', categoryId,
      amountCents: 100000, dueOn: '2026-10-10', competenceOn: '2026-10-01',
      idempotencyKey: 'web:payable:001', recurrence: { frequency: 'monthly', installmentCount: 6 },
    })
    expect(repo.createPayable).toHaveBeenCalledWith(expect.objectContaining({
      payable: expect.objectContaining({
        counterparty: 'Fornecedor A', description: 'Aluguel',
        recurrence: { frequency: 'monthly', installmentCount: 6 },
      }),
    }))
    await expect(service.createPayablePayment('token', 'org-a', payableId, {
      amountCents: 100, method: 'cheque', paidAt: '2026-09-03', idempotencyKey: 'bad:method',
    })).rejects.toMatchObject({ code: 'INVALID_PAYMENT' })
  })

  it('registra recebimento e baixa divididos em múltiplas partes (ex: dinheiro e cartão)', async () => {
    const receivableId = 'aaaaaaaa-7200-4000-8000-000000000001'
    const payableId = 'aaaaaaaa-7500-4000-8000-000000000001'
    const repo = financeRepository({
      createReceivablePayments: vi.fn(async ({ payments }) => ({ payments, replayed: false })),
      createPayablePayments: vi.fn(async ({ payments }) => ({ payments, replayed: false })),
    })
    const service = authService(repo)

    const splitReceivable = await service.createReceivablePayment('token', 'org-a', receivableId, {
      payments: [
        { amountCents: 5000, method: 'cash', paidAt: '2026-09-03T12:00:00Z', idempotencyKey: 'split:rec:1' },
        { amountCents: 10000, method: 'credit_card', paidAt: '2026-09-03T12:00:00Z', externalReference: 'VISA-1234', idempotencyKey: 'split:rec:2' },
      ],
    })
    expect(repo.createReceivablePayments).toHaveBeenCalledWith(expect.objectContaining({
      receivableId,
      payments: [
        expect.objectContaining({ amountCents: 5000, method: 'cash' }),
        expect.objectContaining({ amountCents: 10000, method: 'credit_card', externalReference: 'VISA-1234' }),
      ],
    }))
    expect(splitReceivable.payments).toHaveLength(2)

    const splitPayable = await service.createPayablePayment('token', 'org-a', payableId, {
      payments: [
        { amountCents: 3000, method: 'cash', paidAt: '2026-09-03T12:00:00Z', idempotencyKey: 'split:pay:1' },
        { amountCents: 7000, method: 'debit_card', paidAt: '2026-09-03T12:00:00Z', idempotencyKey: 'split:pay:2' },
      ],
    })
    expect(repo.createPayablePayments).toHaveBeenCalledWith(expect.objectContaining({
      payableId,
      payments: [
        expect.objectContaining({ amountCents: 3000, method: 'cash' }),
        expect.objectContaining({ amountCents: 7000, method: 'debit_card' }),
      ],
    }))
    expect(splitPayable.payments).toHaveLength(2)
  })
})

describe('planos e contratos de clientes', () => {
  const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
  const planId = 'aaaaaaaa-7000-4000-8000-000000000001'
  const contractId = 'aaaaaaaa-7200-4000-8000-000000000001'

  function contractRepository(overrides = {}) {
    return repository({
      getSession: vi.fn(async () => ({
        user: { id: 'user-a', email: 'ana@example.com' },
        organizationId: 'org-a',
        organizations: [{
          id: 'org-a', name: 'Clínica A', roleCode: 'owner', roleName: 'Proprietário',
          permissions: ['clients.read', 'clients.manage', 'finance.read', 'finance.manage'],
        }],
        expiresAt: new Date(Date.now() + 60_000),
      })),
      ...overrides,
    })
  }

  it('lista e cria planos com validação de dados', async () => {
    const repo = contractRepository({
      listPlans: vi.fn(async () => [{ id: planId, name: 'Pilates 2x', priceCents: 30000 }]),
      createPlan: vi.fn(async ({ plan }) => ({ id: planId, ...plan })),
    })
    const service = authService(repo)

    const list = await service.listPlans('token', 'org-a')
    expect(list).toHaveLength(1)
    expect(repo.listPlans).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }))

    const created = await service.createPlan('token', 'org-a', {
      name: '  Pilates 2x/semana  ',
      priceCents: 30000,
    })
    expect(created.name).toBe('Pilates 2x/semana')
    expect(repo.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        name: 'Pilates 2x/semana',
        priceCents: 30000,
        billingRule: { frequency: 'monthly', dueDay: 10 },
      }),
    }))

    await expect(service.createPlan('token', 'org-a', { name: '', priceCents: 100 }))
      .rejects.toMatchObject({ code: 'INVALID_PLAN' })
    await expect(service.createPlan('token', 'org-a', { name: 'Válido', priceCents: -50 }))
      .rejects.toMatchObject({ code: 'INVALID_PLAN' })
  })

  it('cria contrato para o cliente e valida datas e vigência', async () => {
    const repo = contractRepository({
      createClientContract: vi.fn(async ({ contract }) => ({ id: contractId, ...contract })),
      updateClientContract: vi.fn(async ({ contractId, patch }) => ({ id: contractId, ...patch })),
    })
    const service = authService(repo)

    const created = await service.createClientContract('token', 'org-a', clientId, {
      planId,
      startsOn: '2026-10-01',
      endsOn: '2027-10-01',
      agreedPriceCents: 28000,
    })
    expect(created.id).toBe(contractId)
    expect(repo.createClientContract).toHaveBeenCalledWith(expect.objectContaining({
      clientId,
      contract: {
        planId,
        startsOn: '2026-10-01',
        endsOn: '2027-10-01',
        agreedPriceCents: 28000,
        status: 'active',
      },
    }))

    // Data de término anterior ao início é rejeitada
    await expect(service.createClientContract('token', 'org-a', clientId, {
      planId,
      startsOn: '2026-10-01',
      endsOn: '2026-09-01',
    })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })

    // Cancelamento e atualização de contrato
    const updated = await service.updateClientContract('token', 'org-a', clientId, contractId, {
      status: 'cancelled',
    })
    expect(updated.status).toBe('cancelled')
    expect(repo.updateClientContract).toHaveBeenCalledWith(expect.objectContaining({
      clientId,
      contractId,
      patch: { status: 'cancelled' },
    }))
  })
})
