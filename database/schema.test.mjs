import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readDevelopmentSeed, readMigrations } from '../scripts/db/files.mjs'
import { PostgresAuthRepository } from '../server/postgres-auth-repository.mjs'
import { hashPassword, hashToken } from '../server/security.mjs'

const organizationA = 'aaaaaaaa-0000-4000-8000-000000000001'
const organizationB = 'bbbbbbbb-0000-4000-8000-000000000001'
const ownerA = '00000000-0000-4000-8000-000000000001'
const professionalA = '00000000-0000-4000-8000-000000000002'
const ownerB = '00000000-0000-4000-8000-000000000003'

describe('PostgreSQL schema', () => {
  let db
  let migrations
  let repository

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE ROLE clinicflow_app
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    `)
    migrations = await readMigrations()
    for (const migration of migrations) await db.exec(migration.up)
    await db.exec(`BEGIN; ${await readDevelopmentSeed()} COMMIT;`)
    const pool = {
      query: (...args) => db.query(...args),
      connect: async () => ({ query: (...args) => db.query(...args), release: () => {} }),
    }
    repository = new PostgresAuthRepository('postgresql://unused', { pool })
  }, 30_000)

  afterAll(async () => {
    await db.close()
  })

  it('recria o esquema e carrega somente dados identificados como sintéticos', async () => {
    await db.exec(`BEGIN; ${await readDevelopmentSeed()} COMMIT;`)
    const tables = await db.query(`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)
    const users = await db.query('SELECT email_normalized FROM users ORDER BY email_normalized')
    const clients = await db.query('SELECT full_name FROM clients ORDER BY full_name')

    expect(tables.rows[0].count).toBeGreaterThanOrEqual(45)
    expect(users.rows).toHaveLength(4)
    expect(users.rows.every(({ email_normalized }) => email_normalized.endsWith('.invalid'))).toBe(true)
    expect(clients.rows.every(({ full_name }) => full_name.includes('Sintético'))).toBe(true)
  })

  it('impede uma FK de apontar para registro de outra clínica', async () => {
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationB])

    await expect(
      db.query(
        `INSERT INTO client_contacts
          (organization_id, client_id, type, value)
         VALUES ($1, $2, 'email', 'cross-tenant@example.invalid')`,
        [organizationB, 'aaaaaaaa-5000-4000-8000-000000000001'],
      ),
    ).rejects.toThrow()
  })

  it('vincula a RLS ao usuário e à membership ativa, com negação por padrão', async () => {
    await db.exec('SET ROLE clinicflow_app;')

    await db.query("SELECT set_config('app.user_id', $1, false)", [ownerA])
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    const alpha = await db.query('SELECT id FROM organizations ORDER BY id')
    expect(alpha.rows).toEqual([{ id: organizationA }])

    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationB])
    const crossed = await db.query('SELECT id FROM organizations ORDER BY id')
    expect(crossed.rows).toHaveLength(0)

    await db.query("SELECT set_config('app.user_id', $1, false)", [ownerB])
    const beta = await db.query('SELECT id FROM organizations ORDER BY id')
    expect(beta.rows).toEqual([{ id: organizationB }])

    await db.query("SELECT set_config('app.organization_id', '', false)")
    const denied = await db.query('SELECT id FROM organizations')
    expect(denied.rows).toHaveLength(0)

    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    await db.query("SELECT set_config('app.user_id', '', false)")
    const unauthenticated = await db.query('SELECT id FROM organizations')
    expect(unauthenticated.rows).toHaveLength(0)

    await db.exec('RESET ROLE;')
  })

  it('bloqueia leitura e escrita cruzadas no papel da aplicação', async () => {
    await db.exec('SET ROLE clinicflow_app;')
    await db.query("SELECT set_config('app.user_id', $1, false)", [ownerA])
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])

    const visible = await db.query('SELECT organization_id FROM clients ORDER BY id')
    expect(visible.rows.length).toBeGreaterThan(0)
    expect(visible.rows.every(({ organization_id }) => organization_id === organizationA)).toBe(true)

    await expect(
      db.query(
        `INSERT INTO clients (organization_id, full_name)
         VALUES ($1, 'Tentativa cruzada')`,
        [organizationB],
      ),
    ).rejects.toThrow(/row-level security policy/)

    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationB])
    const forgedTenant = await db.query('SELECT id FROM clients')
    expect(forgedTenant.rows).toHaveLength(0)
    await db.exec('RESET ROLE;')
  })

  it('nega imediatamente uma membership revogada', async () => {
    await db.query(
      `UPDATE memberships SET status = 'revoked', revoked_at = now()
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationA, professionalA],
    )
    await db.exec('SET ROLE clinicflow_app;')
    await db.query("SELECT set_config('app.user_id', $1, false)", [professionalA])
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    const denied = await db.query('SELECT id FROM organizations')
    expect(denied.rows).toHaveLength(0)
    await db.exec('RESET ROLE;')
    await db.query(
      `UPDATE memberships SET status = 'active', revoked_at = NULL
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationA, professionalA],
    )
  })

  it('representa a matriz RBAC e não concede permissões clínicas ao admin por padrão', async () => {
    const matrix = await db.query(`
      SELECT r.code AS role_code, p.code AS permission_code
      FROM role_permission_defaults defaults
      JOIN permissions p ON p.id = defaults.permission_id
      JOIN (VALUES ('owner'), ('admin'), ('professional'), ('reception_finance'), ('client')) r(code)
        ON r.code = defaults.role_code
    `)
    const granted = new Set(matrix.rows.map(({ role_code, permission_code }) => `${role_code}:${permission_code}`))

    expect(granted.has('owner:roles.manage_privileged')).toBe(true)
    expect(granted.has('admin:memberships.manage')).toBe(true)
    expect(granted.has('admin:clinical.read')).toBe(false)
    expect(granted.has('reception_finance:finance.manage')).toBe(true)
    expect(granted.has('client:finance.own.read')).toBe(true)
    expect(granted.has('client:finance.manage')).toBe(false)
  })

  it('grava convite e revogação sensíveis na mesma trilha da organização', async () => {
    const membership = await repository.inviteMember({
      actorUserId: ownerA,
      organizationId: organizationA,
      email: 'auditoria.membership@example.invalid',
      roleCode: 'professional',
    })
    await repository.revokeMembership({
      actorUserId: ownerA,
      organizationId: organizationA,
      membershipId: membership.id,
    })

    const events = await db.query(
      `SELECT actor_membership_id, action, target_type, target_id,
              minimal_metadata, occurred_at
       FROM audit_events
       WHERE organization_id = $1 AND target_id = $2
       ORDER BY occurred_at, action`,
      [organizationA, membership.id],
    )
    expect(events.rows).toHaveLength(2)
    expect(events.rows.map(({ action }) => action).sort()).toEqual([
      'membership.invited',
      'membership.revoked',
    ])
    expect(events.rows.every((event) => (
      event.actor_membership_id === 'aaaaaaaa-3000-4000-8000-000000000001'
      && event.target_type === 'membership'
      && event.target_id === membership.id
      && event.occurred_at instanceof Date
    ))).toBe(true)
    expect(events.rows.find(({ action }) => action === 'membership.invited').minimal_metadata)
      .toEqual({ roleCode: 'professional', status: 'invited' })
    expect(events.rows.find(({ action }) => action === 'membership.revoked').minimal_metadata)
      .toEqual({ roleCode: 'professional', previousStatus: 'invited' })

    const firstPage = await repository.listAuditEvents({
      actorUserId: ownerA,
      organizationId: organizationA,
      targetId: membership.id,
      limit: 1,
    })
    expect(firstPage.events).toHaveLength(1)
    expect(firstPage.next).toMatchObject({ id: expect.any(String), occurredAt: expect.any(Date) })
    const secondPage = await repository.listAuditEvents({
      actorUserId: ownerA,
      organizationId: organizationA,
      targetId: membership.id,
      limit: 1,
      cursor: firstPage.next,
    })
    expect(secondPage.events).toHaveLength(1)
    expect(secondPage.events[0].id).not.toBe(firstPage.events[0].id)
    expect(secondPage.next).toBeNull()

    await expect(repository.listAuditEvents({
      actorUserId: professionalA,
      organizationId: organizationA,
      limit: 10,
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
  })

  it('mantém auditoria append-only e aceita somente metadados mínimos em objeto', async () => {
    const auditEvent = 'aaaaaaaa-8100-4000-8000-000000000001'
    await expect(db.query('DELETE FROM audit_events WHERE id = $1', [auditEvent]))
      .rejects.toThrow(/append-only/)
    await expect(db.query(
      `INSERT INTO audit_events
        (organization_id, action, target_type, target_id, minimal_metadata)
       VALUES ($1, 'membership.changed', 'membership', $2, '[]'::jsonb)`,
      [organizationA, 'aaaaaaaa-3000-4000-8000-000000000001'],
    )).rejects.toThrow(/audit_events_metadata_object/)

    await db.exec('SET ROLE clinicflow_app;')
    await db.query("SELECT set_config('app.user_id', $1, false)", [ownerA])
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    await expect(db.query('DELETE FROM audit_events WHERE id = $1', [auditEvent]))
      .rejects.toThrow(/permission denied/)
    await db.exec('RESET ROLE;')
  })

  it('impede o papel da aplicação de consultar credenciais e sessões', async () => {
    await db.exec('SET ROLE clinicflow_app;')
    await expect(db.query('SELECT user_id FROM user_credentials')).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT token_hash FROM sessions')).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT secret_encrypted FROM mfa_totp_factors')).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT code_hash FROM mfa_recovery_codes')).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT token_hash FROM mfa_challenges')).rejects.toThrow(/permission denied/)
    await expect(db.query('SELECT token_hash FROM organization_invitations')).rejects.toThrow(/permission denied/)
    await db.exec('RESET ROLE;')
  })

  it('registra convite de companhia, consulta por token e cadastra usuário sem exigir MFA', async () => {
    const rawToken = 'convite-teste-integracao-123'
    const tokenHash = hashToken(rawToken)
    const email = 'novo.convidado@example.invalid'
    const passwordHash = await hashPassword('SenhaSegura123!')

    const inviteResult = await repository.inviteMember({
      actorUserId: ownerA,
      organizationId: organizationA,
      email,
      roleCode: 'professional',
      inviteTokenHash: tokenHash,
    })
    expect(inviteResult.status).toBe('invited')

    const lookup = await repository.getInvitationByToken(tokenHash)
    expect(lookup).toMatchObject({
      organization_name: expect.any(String),
      email_normalized: email,
      role_code: 'professional',
      status: 'pending',
    })

    const registered = await repository.registerAccountViaInvite({
      inviteTokenHash: tokenHash,
      email,
      passwordHash,
    })
    expect(registered.organizationId).toBe(organizationA)

    const credential = await repository.findCredentialByEmail(email)
    expect(credential.status).toBe('active')
    expect(credential.requiresMfa).toBe(false)
    expect(credential.mfaEnrolled).toBe(false)
  })

  it('rejeita overbooking e redução abaixo da ocupação atual', async () => {
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])

    await expect(
      db.query(
        `INSERT INTO appointments
          (organization_id, unit_id, service_id, professional_id, starts_at, ends_at, capacity)
         VALUES ($1, $2, $3, $4, '2026-09-01 13:10:00-03', '2026-09-01 14:00:00-03', 1)`,
        [
          organizationA,
          'aaaaaaaa-1000-4000-8000-000000000001',
          'aaaaaaaa-6100-4000-8000-000000000001',
          'aaaaaaaa-4000-4000-8000-000000000001',
        ],
      ),
    ).rejects.toThrow(/resource conflict/)

    for (let index = 3; index <= 5; index += 1) {
      const suffix = String(index).padStart(12, '0')
      await db.query(
        `INSERT INTO clients (id, organization_id, full_name)
         VALUES ($1, $2, $3)`,
        [`aaaaaaaa-5000-4000-8000-${suffix}`, organizationA, `Cliente Sintético 00${index}`],
      )
    }

    for (let index = 2; index <= 4; index += 1) {
      const clientSuffix = String(index).padStart(12, '0')
      const participantSuffix = String(index).padStart(12, '0')
      await db.query(
        `INSERT INTO appointment_participants
          (id, organization_id, appointment_id, client_id)
         VALUES ($1, $2, $3, $4)`,
        [
          `aaaaaaaa-6400-4000-8000-${participantSuffix}`,
          organizationA,
          'aaaaaaaa-6300-4000-8000-000000000001',
          `aaaaaaaa-5000-4000-8000-${clientSuffix}`,
        ],
      )
    }

    await expect(
      db.query(
        `INSERT INTO appointment_participants
          (organization_id, appointment_id, client_id)
         VALUES ($1, $2, $3)`,
        [organizationA, 'aaaaaaaa-6300-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000005'],
      ),
    ).rejects.toThrow(/capacity exceeded/)

    await expect(
      db.query('UPDATE appointments SET capacity = 3 WHERE id = $1', [
        'aaaaaaaa-6300-4000-8000-000000000001',
      ]),
    ).rejects.toThrow(/below current occupancy/)
  })

  it('reconcilia pagamentos parciais e estorno sem apagar lançamentos', async () => {
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    const receivable = 'aaaaaaaa-7300-4000-8000-000000000001'
    const payment = 'aaaaaaaa-7400-4000-8000-000000000001'

    await db.query(
      `INSERT INTO payments
        (id, organization_id, receivable_id, amount_cents, method, paid_at, idempotency_key)
       VALUES ($1, $2, $3, 10000, 'synthetic', '2026-09-05 10:00:00-03', 'test:payment:001')`,
      [payment, organizationA, receivable],
    )
    await db.query(
      `INSERT INTO payments
        (organization_id, receivable_id, reverses_payment_id, amount_cents, method, paid_at,
         idempotency_key, reversal_reason)
       VALUES ($1, $2, $3, -10000, 'reversal', '2026-09-05 10:00:00-03', 'test:reversal:001', 'Teste de conciliação')`,
      [organizationA, receivable, payment],
    )
    await db.query(
      `INSERT INTO payments
        (organization_id, receivable_id, amount_cents, method, paid_at, idempotency_key)
       VALUES ($1, $2, 5000, 'synthetic', '2026-09-05 10:00:00-03', 'test:payment:002')`,
      [organizationA, receivable],
    )

    const balance = await db.query(
      'SELECT paid_amount_cents, balance_cents FROM receivable_balances WHERE receivable_id = $1',
      [receivable],
    )
    expect(balance.rows).toEqual([{ paid_amount_cents: 5000, balance_cents: 20000 }])
    await expect(db.query('DELETE FROM payments WHERE id = $1', [payment])).rejects.toThrow(/append-only/)
  })

  it('executa o CRUD seguro de clientes com duplicidade, isolamento e exclusão lógica', async () => {
    const created = await repository.createClient({
      actorUserId: ownerA,
      organizationId: organizationA,
      client: {
        fullName: 'Cliente Sintético CRM 001',
        clientType: 'fixed',
        birthDate: '1995-05-20',
        documentNumber: 'CRM00199',
        contacts: [{
          type: 'email', value: 'crm.001@example.invalid',
          normalizedValue: 'crm.001@example.invalid', preferred: true,
        }],
      },
    })
    expect(created).toMatchObject({
      fullName: 'Cliente Sintético CRM 001',
      clientType: 'fixed',
      operationalRules: { planMode: 'contract', recurrenceMode: 'reserved' },
      documentNumber: 'CRM00199',
      contacts: [{ type: 'email', value: 'crm.001@example.invalid', preferred: true }],
    })

    const visible = await repository.listClients({ actorUserId: professionalA, organizationId: organizationA })
    expect(visible.items.some(({ id }) => id === created.id)).toBe(true)
    const fixed = await repository.listClients({
      actorUserId: professionalA, organizationId: organizationA, clientType: 'fixed',
    })
    expect(fixed.items.every(({ clientType }) => clientType === 'fixed')).toBe(true)
    expect(fixed.items.some(({ id }) => id === created.id)).toBe(true)
    await expect(repository.listClients({ actorUserId: ownerA, organizationId: organizationB }))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    await expect(repository.createClient({
      actorUserId: professionalA,
      organizationId: organizationA,
      client: { fullName: 'Sem permissão', birthDate: null, documentNumber: null, contacts: [] },
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    await expect(repository.createClient({
      actorUserId: ownerA,
      organizationId: organizationA,
      client: {
        fullName: 'Documento duplicado', birthDate: null, documentNumber: 'CRM00199', contacts: [],
      },
    })).rejects.toMatchObject({ code: '23505' })

    const updated = await repository.updateClient({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: created.id,
      client: {
        fullName: 'Cliente Sintético CRM Atualizado',
        clientType: 'rotating',
        birthDate: null,
        documentNumber: 'CRM00199',
        contacts: [{
          type: 'phone', value: '(47) 99999-1111',
          normalizedValue: '47999991111', preferred: true,
        }],
      },
    })
    expect(updated).toMatchObject({
      fullName: 'Cliente Sintético CRM Atualizado', birthDate: null,
      clientType: 'rotating',
      operationalRules: {
        planMode: 'credits_or_single_booking', recurrenceMode: 'availability_only',
      },
      contacts: [{ type: 'phone', value: '(47) 99999-1111' }],
    })

    expect(await repository.archiveClient({
      actorUserId: ownerA, organizationId: organizationA, clientId: created.id,
    })).toBe(true)
    expect(await repository.getClient({
      actorUserId: ownerA, organizationId: organizationA, clientId: created.id,
    })).toBeNull()
    const stored = await db.query('SELECT status, deleted_at FROM clients WHERE id = $1', [created.id])
    expect(stored.rows[0]).toMatchObject({ status: 'archived', deleted_at: expect.any(Date) })

    const audit = await db.query(
      `SELECT action, minimal_metadata FROM audit_events
       WHERE organization_id = $1 AND target_id = $2 ORDER BY occurred_at`,
      [organizationA, created.id],
    )
    expect(audit.rows.map(({ action }) => action)).toEqual([
      'client.created', 'client.updated', 'client.archived',
    ])
    expect(JSON.stringify(audit.rows)).not.toContain('crm.001@example.invalid')
    expect(JSON.stringify(audit.rows)).not.toContain('Cliente Sintético CRM')
    expect(audit.rows[1].minimal_metadata).toMatchObject({
      clientType: 'rotating', previousClientType: 'fixed',
    })
  })

  it('busca e pagina no banco e compõe o perfil conforme as permissões', async () => {
    const firstPage = await repository.listClients({
      actorUserId: ownerA,
      organizationId: organizationA,
      search: 'cliente sintético',
      contactSearch: 'cliente sintético',
      page: 1,
      pageSize: 1,
    })
    expect(firstPage.total).toBeGreaterThanOrEqual(2)
    expect(firstPage.items).toHaveLength(1)

    const byNameFragment = await repository.listClients({
      actorUserId: ownerA,
      organizationId: organizationA,
      search: 'sintetico',
      page: 1,
      pageSize: 20,
    })
    expect(byNameFragment.items.map(({ fullName }) => fullName)).toEqual(
      expect.arrayContaining(['Cliente Sintético 001', 'Cliente Sintético 002']),
    )

    const byContact = await repository.listClients({
      actorUserId: ownerA,
      organizationId: organizationA,
      search: 'cliente.001@',
      page: 1,
      pageSize: 20,
    })
    expect(byContact.items).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-5000-4000-8000-000000000001' }),
    ])

    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const ownerProfile = await repository.getClientProfile({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId,
      sections: { schedule: true, plan: true, finance: true, history: true },
    })
    expect(ownerProfile).toMatchObject({
      client: { id: clientId },
      access: { schedule: true, plan: true, finance: true, history: true },
      schedule: [expect.objectContaining({ serviceName: 'Aula Demonstrativa' })],
      plan: [expect.objectContaining({ name: 'Plano Sintético Mensal', agreedPriceCents: 25000 })],
      finance: { openBalanceCents: 20000 },
    })
    expect(Array.isArray(ownerProfile.history)).toBe(true)

    const professionalProfile = await repository.getClientProfile({
      actorUserId: professionalA,
      organizationId: organizationA,
      clientId,
      sections: { schedule: false, plan: false, finance: false, history: false },
    })
    expect(professionalProfile).toMatchObject({
      schedule: null,
      plan: null,
      finance: null,
      history: null,
    })
    await expect(repository.getClientProfile({
      actorUserId: professionalA,
      organizationId: organizationA,
      clientId,
      sections: { schedule: true, plan: false, finance: false, history: false },
    })).resolves.toMatchObject({
      access: { schedule: true, plan: false, finance: false, history: false },
      schedule: [expect.objectContaining({
        serviceName: 'Aula Demonstrativa',
        professionalRegistrationNumber: 'CREFITO-3/12345-F',
      })],
      plan: null, finance: null, history: null,
    })

    const clinicalProfile = await repository.getClientProfile({
      actorUserId: professionalA,
      organizationId: organizationA,
      clientId,
      sections: { schedule: false, plan: false, finance: false, history: false, clinical: true },
    })
    expect(clinicalProfile.clinicalRecords).toEqual([
      expect.objectContaining({
        recordType: 'evolucao',
        authorProfessional: expect.objectContaining({
          displayName: 'Profissional Sintético 001',
          registrationNumber: 'CREFITO-3/12345-F',
        }),
      }),
    ])

    const createdRecord = await repository.createClientClinicalRecord({
      actorUserId: professionalA,
      organizationId: organizationA,
      clientId,
      recordType: 'evolucao',
      content: 'Nova evolução registrada pelo fisioterapeuta com melhora do quadro.',
      occurredAt: '2026-09-03T10:00:00-03:00',
    })
    expect(createdRecord).toMatchObject({
      recordType: 'evolucao',
      content: 'Nova evolução registrada pelo fisioterapeuta com melhora do quadro.',
      authorProfessional: {
        displayName: 'Profissional Sintético 001',
        registrationNumber: 'CREFITO-3/12345-F',
      },
    })
    expect(createdRecord.signedAt).toBeTruthy()

    // Imutabilidade legal do prontuário assinado
    await expect(
      db.query('DELETE FROM clinical_records WHERE id = $1', [createdRecord.id]),
    ).rejects.toThrow(/signed clinical record requires an addendum/)

    const clinicalList = await repository.listClientClinicalRecords({
      actorUserId: professionalA,
      organizationId: organizationA,
      clientId,
    })
    expect(clinicalList.items.length).toBeGreaterThanOrEqual(2)
    expect(clinicalList.items[0]).toMatchObject({
      authorProfessional: {
        displayName: 'Profissional Sintético 001',
        registrationNumber: 'CREFITO-3/12345-F',
      },
    })
  })

  it('gerencia planos e contratos do cliente, atualizando o tipo para fixo e registrando auditoria', async () => {
    const plansBefore = await repository.listPlans({
      actorUserId: ownerA,
      organizationId: organizationA,
    })
    expect(plansBefore.length).toBeGreaterThanOrEqual(1)

    const newPlan = await repository.createPlan({
      actorUserId: ownerA,
      organizationId: organizationA,
      plan: {
        name: 'Pilates Clínico Duo Especial',
        priceCents: 35000,
        billingRule: { frequency: 'monthly', dueDay: 15 },
        active: true,
      },
    })
    expect(newPlan).toMatchObject({
      name: 'Pilates Clínico Duo Especial',
      priceCents: 35000,
      active: true,
    })

    const rotatingClient = await repository.createClient({
      actorUserId: ownerA,
      organizationId: organizationA,
      client: {
        fullName: 'Cliente Rotativo Para Contrato',
        clientType: 'rotating',
        birthDate: null,
        documentNumber: 'CONTRATO001',
        contacts: [{ type: 'phone', value: '47999990001', preferred: true }],
      },
    })
    expect(rotatingClient.clientType).toBe('rotating')

    const contract = await repository.createClientContract({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: rotatingClient.id,
      contract: {
        planId: newPlan.id,
        startsOn: '2026-10-01',
        endsOn: '2027-10-01',
        agreedPriceCents: 32000,
        status: 'active',
      },
    })
    expect(contract).toMatchObject({
      clientId: rotatingClient.id,
      planId: newPlan.id,
      name: 'Pilates Clínico Duo Especial',
      agreedPriceCents: 32000,
      status: 'active',
    })

    // Cliente rotativo se torna fixo automaticamente ao ativar contrato
    const updatedClient = await repository.getClient({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: rotatingClient.id,
    })
    expect(updatedClient.clientType).toBe('fixed')

    // Listagem de contratos
    const contracts = await repository.listClientContracts({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: rotatingClient.id,
    })
    expect(contracts).toHaveLength(1)
    expect(contracts[0].id).toBe(contract.id)

    // Perfil do cliente exibe o contrato no plano
    const profile = await repository.getClientProfile({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: rotatingClient.id,
      sections: { plan: true },
    })
    expect(profile.plan).toEqual([
      expect.objectContaining({
        id: contract.id,
        planId: newPlan.id,
        name: 'Pilates Clínico Duo Especial',
        agreedPriceCents: 32000,
        status: 'active',
      }),
    ])

    // Atualização de situação (cancelamento)
    const cancelledContract = await repository.updateClientContract({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: rotatingClient.id,
      contractId: contract.id,
      patch: { status: 'cancelled' },
    })
    expect(cancelledContract.status).toBe('cancelled')

    // Isolamento multiempresa: clínica B não acessa cliente da clínica A
    await expect(repository.listClientContracts({
      actorUserId: ownerA,
      organizationId: organizationB,
      clientId: rotatingClient.id,
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    // Cliente inexistente na clínica retorna 404
    await expect(repository.listClientContracts({
      actorUserId: ownerA,
      organizationId: organizationA,
      clientId: 'bbbbbbbb-5000-4000-8000-000000000001',
    })).rejects.toMatchObject({ status: 404, code: 'CLIENT_NOT_FOUND' })
  })

  it('mantém o funil e converte a prospecção uma única vez com todo o histórico', async () => {
    await expect(repository.createProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospect: {
        fullName: 'Responsável de outra clínica', source: 'Teste sintético', stage: 'new',
        ownerProfessionalId: 'bbbbbbbb-4000-4000-8000-000000000001',
        nextActionAt: null, nextActionNote: null, contacts: [],
      },
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_PROSPECT_OWNER' })

    const prospect = await repository.createProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospect: {
        fullName: 'Prospecção Sintética LEAD 001',
        source: 'Indicação sintética',
        stage: 'new',
        ownerProfessionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        nextActionAt: new Date('2026-09-10T14:00:00-03:00'),
        nextActionNote: 'Confirmar aula sintética',
        contacts: [{
          type: 'email', value: 'lead.001@example.invalid',
          normalizedValue: 'lead.001@example.invalid', preferred: true,
        }],
      },
    })
    expect(prospect).toMatchObject({
      fullName: 'Prospecção Sintética LEAD 001',
      stage: 'new',
      source: 'Indicação sintética',
      owner: { displayName: 'Profissional Sintético 001' },
      nextActionNote: 'Confirmar aula sintética',
      contacts: [{ type: 'email', value: 'lead.001@example.invalid' }],
    })

    const listed = await repository.listProspects({
      actorUserId: ownerA, organizationId: organizationA,
      stage: 'new', search: 'prospecção sintética', page: 1, pageSize: 10,
    })
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prospect.id }),
    ]))
    expect(listed.stageCounts.new).toBeGreaterThanOrEqual(1)
    expect(listed.owners).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-4000-4000-8000-000000000001' }),
    ])
    await expect(repository.listProspects({
      actorUserId: professionalA, organizationId: organizationA,
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    await expect(repository.getProspect({
      actorUserId: ownerA, organizationId: organizationB, prospectId: prospect.id,
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    const updated = await repository.updateProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospectId: prospect.id,
      prospect: {
        fullName: prospect.fullName,
        source: prospect.source,
        stage: 'qualified',
        ownerProfessionalId: prospect.owner.id,
        nextActionAt: new Date('2026-09-12T10:00:00-03:00'),
        nextActionNote: 'Enviar proposta sintética',
        contacts: [{
          type: 'email', value: 'lead.001@example.invalid',
          normalizedValue: 'lead.001@example.invalid', preferred: true,
        }],
      },
    })
    expect(updated.stage).toBe('qualified')
    await repository.addProspectInteraction({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospectId: prospect.id,
      interaction: {
        type: 'call', notes: 'Contato sintético concluído.',
        occurredAt: new Date('2026-09-02T12:00:00-03:00'),
      },
    })

    const firstConversion = await repository.convertProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospectId: prospect.id,
      conversion: { clientType: 'fixed', birthDate: '1994-03-10', documentNumber: 'LEAD00199' },
    })
    const repeatedConversion = await repository.convertProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospectId: prospect.id,
      conversion: { clientType: 'rotating', birthDate: null, documentNumber: null },
    })
    expect(firstConversion).toMatchObject({
      created: true,
      client: {
        fullName: 'Prospecção Sintética LEAD 001', clientType: 'fixed',
        documentNumber: 'LEAD00199',
        contacts: [{ type: 'email', value: 'lead.001@example.invalid' }],
      },
      prospect: { stage: 'converted' },
    })
    expect(repeatedConversion).toMatchObject({
      created: false,
      client: { id: firstConversion.client.id, clientType: 'fixed' },
      prospect: { id: prospect.id, convertedClientId: firstConversion.client.id },
    })
    expect(firstConversion.prospect.interactions.map(({ type }) => type)).toEqual(
      expect.arrayContaining(['stage_change', 'call', 'conversion']),
    )
    await expect(repository.updateProspect({
      actorUserId: ownerA, organizationId: organizationA, prospectId: prospect.id,
      prospect: {
        fullName: prospect.fullName, source: prospect.source, stage: 'lost',
        ownerProfessionalId: null, nextActionAt: null, nextActionNote: null, contacts: [],
      },
    })).rejects.toMatchObject({ status: 409, code: 'PROSPECT_CONVERTED' })

    const clients = await db.query(
      'SELECT count(*)::int AS count FROM clients WHERE organization_id = $1 AND full_name = $2',
      [organizationA, 'Prospecção Sintética LEAD 001'],
    )
    expect(clients.rows[0].count).toBe(1)
    const storedProspect = await db.query(
      'SELECT stage, converted_client_id FROM prospects WHERE id = $1', [prospect.id],
    )
    expect(storedProspect.rows[0]).toEqual({
      stage: 'converted', converted_client_id: firstConversion.client.id,
    })
    const audit = await db.query(
      `SELECT action, minimal_metadata FROM audit_events
       WHERE organization_id = $1 AND (target_id = $2 OR target_id = $3)
       ORDER BY occurred_at, id`,
      [organizationA, prospect.id, firstConversion.client.id],
    )
    expect(audit.rows.map(({ action }) => action)).toEqual(expect.arrayContaining([
      'prospect.created', 'prospect.updated', 'prospect.interaction.created',
      'client.created', 'prospect.converted',
    ]))
    expect(JSON.stringify(audit.rows)).not.toContain('lead.001@example.invalid')
    expect(JSON.stringify(audit.rows)).not.toContain('Prospecção Sintética LEAD 001')

    const duplicate = await repository.createProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospect: {
        fullName: 'Prospecção Sintética Duplicada', source: 'Teste sintético', stage: 'new',
        ownerProfessionalId: null, nextActionAt: null, nextActionNote: null,
        contacts: [{
          type: 'email', value: 'lead.001@example.invalid',
          normalizedValue: 'lead.001@example.invalid', preferred: true,
        }],
      },
    })
    await expect(repository.convertProspect({
      actorUserId: ownerA,
      organizationId: organizationA,
      prospectId: duplicate.id,
      conversion: { clientType: 'rotating', birthDate: null, documentNumber: null },
    })).rejects.toMatchObject({ code: '23505' })
    const preservedAfterConflict = await repository.getProspect({
      actorUserId: ownerA, organizationId: organizationA, prospectId: duplicate.id,
    })
    expect(preservedAfterConflict).toMatchObject({ stage: 'new', convertedClientId: null })
  })

  it('cadastra, associa e inativa recursos sem apagar o histórico da agenda', async () => {
    const initial = await repository.listResources({
      actorUserId: ownerA, organizationId: organizationA,
    })
    expect(initial).toMatchObject({
      modalities: [expect.objectContaining({ name: 'Modalidade Sintética', associationsCount: 1 })],
      services: [expect.objectContaining({ name: 'Aula Demonstrativa', associationsCount: 1 })],
      rooms: [expect.objectContaining({ name: 'Sala Sintética 01', associationsCount: 1 })],
      equipment: [expect.objectContaining({ name: 'Reformer Sintético', associationsCount: 1 })],
      units: [expect.objectContaining({ name: 'Unidade Sintética Centro' })],
    })
    await expect(repository.listResources({
      actorUserId: professionalA, organizationId: organizationA,
    })).resolves.toMatchObject({ services: expect.any(Array) })
    await expect(repository.createResource({
      actorUserId: professionalA, organizationId: organizationA, kind: 'modalities',
      resource: { name: 'Sem permissão', active: true },
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    const modality = await repository.createResource({
      actorUserId: ownerA, organizationId: organizationA, kind: 'modalities',
      resource: { name: 'Fisioterapia Sintética', active: true },
    })
    const service = await repository.createResource({
      actorUserId: ownerA, organizationId: organizationA, kind: 'services',
      resource: {
        name: 'Sessão Sintética', modalityId: modality.id,
        durationMinutes: 45, defaultCapacity: 1, active: true,
      },
    })
    expect(service).toMatchObject({
      name: 'Sessão Sintética', modalityName: 'Fisioterapia Sintética', active: true,
    })
    const inactive = await repository.updateResource({
      actorUserId: ownerA, organizationId: organizationA, kind: 'services', resourceId: service.id,
      resource: {
        name: service.name, modalityId: service.modalityId,
        durationMinutes: service.durationMinutes, defaultCapacity: service.defaultCapacity, active: false,
      },
    })
    expect(inactive.active).toBe(false)
    const filtered = await repository.listResources({
      actorUserId: ownerA, organizationId: organizationA, active: false,
    })
    expect(filtered.services).toEqual([expect.objectContaining({ id: service.id })])

    await expect(repository.createResource({
      actorUserId: ownerA, organizationId: organizationA, kind: 'modalities',
      resource: { name: ' fisioterapia sintética ', active: true },
    })).rejects.toMatchObject({ code: '23505' })
    const audit = await db.query(
      `SELECT action, minimal_metadata FROM audit_events
       WHERE organization_id = $1 AND target_id IN ($2, $3) ORDER BY occurred_at, id`,
      [organizationA, modality.id, service.id],
    )
    expect(audit.rows.map(({ action }) => action)).toEqual([
      'resource.created', 'resource.created', 'resource.updated',
    ])
    expect(JSON.stringify(audit.rows)).not.toContain('Sessão Sintética')
  })

  it('respeita expediente, bloqueios e ciclo do agendamento individual', async () => {
    const organizationId = organizationA
    const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
    const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
    const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000002'

    await expect(repository.createAppointment({
      actorUserId: ownerA,
      organizationId,
      appointment: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-09-08T12:15:00-03:00'),
      },
    })).rejects.toMatchObject({ code: '23P01' })

    const created = await repository.createAppointment({
      actorUserId: ownerA,
      organizationId,
      appointment: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-09-08T10:00:00-03:00'),
      },
    })
    expect(created).toMatchObject({
      client: { id: clientId }, professional: { id: professionalId },
      service: { id: serviceId, durationMinutes: 50 }, status: 'scheduled',
      capacity: 1, occupancy: 1,
    })
    expect(new Date(created.endsAt).getTime() - new Date(created.startsAt).getTime()).toBe(50 * 60_000)

    await expect(repository.createAppointment({
      actorUserId: ownerA,
      organizationId,
      appointment: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000001', professionalId, unitId,
        serviceId, roomId: null, startsAt: new Date('2026-09-08T10:20:00-03:00'),
      },
    })).rejects.toMatchObject({ code: '23P01' })

    await expect(repository.createAvailability({
      actorUserId: ownerA,
      organizationId,
      availability: {
        professionalId, unitId, kind: 'vacation', weekday: null,
        localStartTime: null, localEndTime: null,
        startsAt: new Date('2026-09-01T12:50:00-03:00'),
        endsAt: new Date('2026-09-01T14:00:00-03:00'),
        timezone: 'America/Sao_Paulo', label: 'Férias conflitantes', active: true,
      },
    })).rejects.toMatchObject({ status: 409, code: 'AVAILABILITY_CONFLICT' })

    const updated = await repository.updateAppointment({
      actorUserId: ownerA,
      organizationId,
      appointmentId: created.id,
      appointment: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-09-08T11:00:00-03:00'),
      },
    })
    expect(updated.startsAt).toEqual(new Date('2026-09-08T14:00:00.000Z'))

    const cancelled = await repository.cancelAppointment({
      actorUserId: ownerA, organizationId, appointmentId: created.id,
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(Date) })
    const repeated = await repository.cancelAppointment({
      actorUserId: ownerA, organizationId, appointmentId: created.id,
    })
    expect(repeated.status).toBe('cancelled')

    const schedule = await repository.getSchedule({
      actorUserId: ownerA, organizationId,
      from: new Date('2026-09-08T00:00:00-03:00'),
      to: new Date('2026-09-09T00:00:00-03:00'),
    })
    expect(schedule.appointments).toEqual([
      expect.objectContaining({ id: created.id, status: 'cancelled' }),
    ])
    expect(schedule).toMatchObject({
      professionals: [expect.objectContaining({ id: professionalId })],
      services: [expect.objectContaining({ id: serviceId })],
      clients: expect.arrayContaining([expect.objectContaining({ id: clientId })]),
    })

    const audit = await db.query(
      `SELECT action, minimal_metadata FROM audit_events
       WHERE organization_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
      [organizationId, created.id],
    )
    expect(audit.rows.map(({ action }) => action)).toEqual([
      'appointment.created', 'appointment.updated', 'appointment.cancelled',
    ])
    expect(JSON.stringify(audit.rows)).not.toContain('Cliente Sintético')

    const otherProfessionalId = 'aaaaaaaa-4000-4000-8000-000000000099'
    await db.query(
      `INSERT INTO professionals (id, organization_id, display_name)
       VALUES ($1, $2, 'Outro Profissional Sintético')`,
      [otherProfessionalId, organizationId],
    )
    await expect(repository.createAvailability({
      actorUserId: professionalA,
      organizationId,
      availability: {
        professionalId: otherProfessionalId, unitId, kind: 'working_hours', weekday: 2,
        localStartTime: '08:00', localEndTime: '18:00', startsAt: null, endsAt: null,
        timezone: 'America/Sao_Paulo', label: 'Expediente alheio', active: true,
      },
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })

    const ownSchedule = await repository.getSchedule({
      actorUserId: professionalA, organizationId,
      from: new Date('2026-09-01T00:00:00-03:00'),
      to: new Date('2026-09-02T00:00:00-03:00'),
      professionalId: otherProfessionalId,
    })
    expect(ownSchedule.appointments.every(({ professional }) => professional.id === professionalId)).toBe(true)
    expect(ownSchedule.professionals).toEqual([
      expect.objectContaining({ id: professionalId }),
    ])
  })

  it('mantém capacidade de turma atômica e libera a vaga após cancelamento', async () => {
    const organizationId = organizationA
    const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
    const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
    const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
    const clients = [
      'aaaaaaaa-5000-4000-8000-000000000011',
      'aaaaaaaa-5000-4000-8000-000000000012',
      'aaaaaaaa-5000-4000-8000-000000000013',
    ]
    for (const [index, clientId] of clients.entries()) {
      await db.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético Turma ${index + 1}`],
      )
    }

    const created = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-10-06T10:00:00-03:00'), capacity: 2,
        clientIds: [clients[0]],
      },
    })
    expect(created).toMatchObject({ appointmentType: 'class', capacity: 2, occupancy: 1 })

    const full = await repository.addAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: created.id, clientId: clients[1],
    })
    expect(full.occupancy).toBe(2)
    await expect(repository.addAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: created.id, clientId: clients[2],
    })).rejects.toMatchObject({ code: '23514' })

    const released = await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: created.id, clientId: clients[0],
    })
    expect(released.occupancy).toBe(1)
    const filledAgain = await repository.addAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: created.id, clientId: clients[2],
    })
    expect(filledAgain).toMatchObject({ occupancy: 2, capacity: 2 })
  })

  it('preserva a ordem da fila e oferece uma vaga por vez, avançando após expiração', async () => {
    const organizationId = organizationA
    const secondParticipant = 'aaaaaaaa-5000-4000-8000-000000000020'
    await db.query(
      `INSERT INTO clients (id, organization_id, full_name, client_type)
       VALUES ($1, $2, 'Cliente Sintético Ocupante da Fila', 'rotating')`,
      [secondParticipant, organizationId],
    )
    const appointment = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2026-12-07T10:00:00-03:00'), capacity: 2,
        clientIds: ['aaaaaaaa-5000-4000-8000-000000000002', secondParticipant], equipment: [],
      },
    })
    const first = await repository.joinOwnWaitlist({
      actorUserId: '00000000-0000-4000-8000-000000000004',
      organizationId, appointmentId: appointment.id,
    })
    const repeated = await repository.joinOwnWaitlist({
      actorUserId: '00000000-0000-4000-8000-000000000004',
      organizationId, appointmentId: appointment.id,
    })
    expect(repeated.id).toBe(first.id)
    expect(first).toMatchObject({ status: 'queued', position: 1 })

    const waitingClients = [
      'aaaaaaaa-5000-4000-8000-000000000021',
      'aaaaaaaa-5000-4000-8000-000000000022',
    ]
    for (const [index, clientId] of waitingClients.entries()) {
      await db.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético Fila ${index + 2}`],
      )
      await db.query(
        `INSERT INTO waitlist_entries
          (organization_id, appointment_id, client_id, queue_position)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, appointment.id, clientId, index + 2],
      )
    }
    await expect(db.query(
      `INSERT INTO waitlist_entries
        (organization_id, appointment_id, client_id, queue_position)
       VALUES ($1, $2, $3, 4)`,
      [organizationId, appointment.id, waitingClients[0]],
    )).rejects.toThrow()

    const released = await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: 'aaaaaaaa-5000-4000-8000-000000000002',
    })
    expect(released.waitlist).toEqual([
      expect.objectContaining({ id: first.id, status: 'offered', position: 1 }),
      expect.objectContaining({ status: 'queued', position: 2 }),
      expect.objectContaining({ status: 'queued', position: 3 }),
    ])
    const activeFirst = await db.query(
      `SELECT id, waitlist_entry_id FROM waitlist_offers
       WHERE organization_id = $1 AND appointment_id = $2 AND status = 'active'`,
      [organizationId, appointment.id],
    )
    expect(activeFirst.rows).toHaveLength(1)
    expect(activeFirst.rows[0].waitlist_entry_id).toBe(first.id)

    await expect(repository.addAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: waitingClients[1],
    })).rejects.toMatchObject({ code: 'WAITLIST_OFFER_ACTIVE' })

    await db.query(
      `UPDATE waitlist_offers
       SET offered_at = clock_timestamp() - interval '2 minutes',
           expires_at = clock_timestamp() - interval '1 minute'
       WHERE id = $1`,
      [activeFirst.rows[0].id],
    )
    const advanced = await repository.advanceWaitlistOffer({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
    })
    const repeatedAdvance = await repository.advanceWaitlistOffer({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
    })
    expect(repeatedAdvance.id).toBe(advanced.id)

    const state = await db.query(
      `SELECT entry.id, entry.status, entry.queue_position,
              offer.status AS offer_status
       FROM waitlist_entries entry
       LEFT JOIN waitlist_offers offer
         ON offer.organization_id = entry.organization_id
        AND offer.waitlist_entry_id = entry.id
       WHERE entry.organization_id = $1 AND entry.appointment_id = $2
       ORDER BY entry.queue_position`,
      [organizationId, appointment.id],
    )
    expect(state.rows).toEqual([
      expect.objectContaining({ id: first.id, status: 'expired', offer_status: 'expired' }),
      expect.objectContaining({ status: 'offered', queue_position: 2, offer_status: 'active' }),
      expect.objectContaining({ status: 'queued', queue_position: 3 }),
    ])
    const events = await db.query(
      `SELECT event_type, count(*)::int AS count FROM outbox_events
       WHERE organization_id = $1 AND aggregate_type = 'waitlist_offer'
       GROUP BY event_type ORDER BY event_type`,
      [organizationId],
    )
    expect(events.rows).toEqual([
      { event_type: 'waitlist.offer.created', count: 2 },
      { event_type: 'waitlist.offer.expired', count: 1 },
    ])
  })

  it('confirma a oferta uma única vez após revalidar vaga, plano e conflito de horário', async () => {
    const organizationId = organizationA
    const linkedClientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const clientUserId = '00000000-0000-4000-8000-000000000004'
    const participantIds = [
      'aaaaaaaa-5000-4000-8000-000000000030',
      'aaaaaaaa-5000-4000-8000-000000000031',
      'aaaaaaaa-5000-4000-8000-000000000032',
    ]
    for (const [index, clientId] of participantIds.entries()) {
      await db.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético Confirmação ${index + 1}`],
      )
    }

    const appointment = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2027-01-04T10:00:00-03:00'), capacity: 2,
        clientIds: participantIds.slice(0, 2), equipment: [],
      },
    })
    await repository.joinOwnWaitlist({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: participantIds[0],
    })

    const bypass = await db.query(
      `INSERT INTO appointment_participants
        (organization_id, appointment_id, client_id, status)
       VALUES ($1, $2, $3, 'confirmed') RETURNING id`,
      [organizationId, appointment.id, participantIds[2]],
    )
    await expect(repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })).rejects.toMatchObject({ code: '23514' })
    await db.query(
      `UPDATE appointment_participants SET status = 'cancelled'
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, bypass.rows[0].id],
    )

    const otherProfessionalId = 'aaaaaaaa-4000-4000-8000-000000000097'
    await db.query(
      `INSERT INTO professionals (id, organization_id, display_name)
       VALUES ($1, $2, 'Profissional Sintético Confirmação')`,
      [otherProfessionalId, organizationId],
    )
    await db.query(
      `INSERT INTO availability_rules
        (organization_id, professional_id, unit_id, rule_type, kind, weekday,
         local_start_time, local_end_time, timezone, label)
       VALUES ($1, $2, $3, 'available', 'working_hours', 1,
               '08:00', '18:00', 'America/Sao_Paulo', 'Expediente sintético confirmação')`,
      [organizationId, otherProfessionalId, 'aaaaaaaa-1000-4000-8000-000000000001'],
    )
    const conflicting = await repository.createAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        clientId: linkedClientId, professionalId: otherProfessionalId,
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2027-01-04T10:00:00-03:00'), equipment: [],
      },
    })
    await expect(repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })).rejects.toMatchObject({ code: '23P01' })
    await repository.cancelAppointment({
      actorUserId: ownerA, organizationId, appointmentId: conflicting.id,
    })

    const confirmed = await repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    const repeated = await repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    expect(confirmed).toMatchObject({
      id: appointment.id, participantStatus: 'confirmed', participantId: expect.any(String),
    })
    expect(repeated.participantId).toBe(confirmed.participantId)

    const state = await db.query(
      `SELECT offer.status AS offer_status, offer.consumed_by_participant_id,
              entry.status AS entry_status
       FROM waitlist_offers offer
       JOIN waitlist_entries entry
         ON entry.organization_id = offer.organization_id
        AND entry.id = offer.waitlist_entry_id
       WHERE offer.organization_id = $1 AND offer.appointment_id = $2
         AND entry.client_id = $3`,
      [organizationId, appointment.id, linkedClientId],
    )
    expect(state.rows).toEqual([{
      offer_status: 'consumed', consumed_by_participant_id: confirmed.participantId,
      entry_status: 'consumed',
    }])
    const effects = await db.query(
      `SELECT
         (SELECT count(*)::int FROM audit_events
          WHERE organization_id = $1 AND action = 'waitlist.offer_consumed'
            AND minimal_metadata->>'appointmentId' = $2::text) AS audits,
         (SELECT count(*)::int FROM outbox_events
          WHERE organization_id = $1 AND event_type = 'waitlist.offer.consumed'
            AND safe_payload->>'appointmentId' = $2::text) AS events`,
      [organizationId, appointment.id],
    )
    expect(effects.rows[0]).toEqual({ audits: 1, events: 1 })

    await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: linkedClientId,
    })
    await repository.addAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: participantIds[0],
    })
    await repository.joinOwnWaitlist({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: participantIds[0],
    })
    const confirmedAgain = await repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    expect(confirmedAgain.participantId).not.toBe(confirmed.participantId)
  })

  it('exige cobertura vigente e consome um único crédito quando não há plano', async () => {
    const organizationId = organizationA
    const linkedClientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const clientUserId = '00000000-0000-4000-8000-000000000004'
    const occupants = [
      'aaaaaaaa-5000-4000-8000-000000000033',
      'aaaaaaaa-5000-4000-8000-000000000034',
    ]
    for (const [index, clientId] of occupants.entries()) {
      await db.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético Crédito ${index + 1}`],
      )
    }
    const appointment = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2027-01-11T10:00:00-03:00'), capacity: 2,
        clientIds: occupants, equipment: [],
      },
    })
    await repository.joinOwnWaitlist({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    await repository.cancelAppointmentParticipant({
      actorUserId: ownerA, organizationId, appointmentId: appointment.id,
      clientId: occupants[0],
    })
    await db.query(
      `UPDATE contracts SET status = 'suspended'
       WHERE organization_id = $1 AND client_id = $2 AND status = 'active'`,
      [organizationId, linkedClientId],
    )

    await expect(repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })).rejects.toMatchObject({ status: 409, code: 'WAITLIST_COVERAGE_REQUIRED' })
    const rolledBack = await db.query(
      `SELECT count(*)::int AS count FROM appointment_participants
       WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
         AND status IN ('booked', 'confirmed', 'attended')`,
      [organizationId, appointment.id, linkedClientId],
    )
    expect(rolledBack.rows[0].count).toBe(0)

    const sourceAppointmentId = 'aaaaaaaa-6300-4000-8000-000000000099'
    const sourceParticipantId = 'aaaaaaaa-6400-4000-8000-000000000099'
    await db.query(
      `INSERT INTO appointments
        (id, organization_id, unit_id, service_id, professional_id,
         starts_at, ends_at, status, capacity, appointment_type)
       VALUES ($1, $2, $3, $4, $5,
               '2027-01-01 10:00:00-03', '2027-01-01 10:50:00-03',
               'completed', 1, 'individual')`,
      [sourceAppointmentId, organizationId,
        'aaaaaaaa-1000-4000-8000-000000000001',
        'aaaaaaaa-6100-4000-8000-000000000001',
        'aaaaaaaa-4000-4000-8000-000000000001'],
    )
    await db.query(
      `INSERT INTO appointment_participants
        (id, organization_id, appointment_id, client_id, status)
       VALUES ($1, $2, $3, $4, 'absent')`,
      [sourceParticipantId, organizationId, sourceAppointmentId, linkedClientId],
    )
    const credit = await db.query(
      `INSERT INTO replacement_credits
        (organization_id, client_id, source_participant_id, expires_on)
       VALUES ($1, $2, $3, DATE '2027-01-11') RETURNING id`,
      [organizationId, linkedClientId, sourceParticipantId],
    )
    const confirmed = await repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    const consumedCredit = await db.query(
      `SELECT status, consumed_by_participant_id
       FROM replacement_credits WHERE organization_id = $1 AND id = $2`,
      [organizationId, credit.rows[0].id],
    )
    expect(consumedCredit.rows).toEqual([{
      status: 'consumed', consumed_by_participant_id: confirmed.participantId,
    }])
    await db.query(
      `UPDATE contracts SET status = 'active'
       WHERE organization_id = $1 AND client_id = $2 AND status = 'suspended'`,
      [organizationId, linkedClientId],
    )
  })

  it('emite, lista e consome reposição atomicamente sem saldo negativo', async () => {
    const organizationId = organizationA
    const linkedClientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const clientUserId = '00000000-0000-4000-8000-000000000004'
    const sourceAppointmentId = 'aaaaaaaa-6300-4000-8000-000000000097'
    const sourceParticipantId = 'aaaaaaaa-6400-4000-8000-000000000097'
    await db.query(
      `INSERT INTO appointments
        (id, organization_id, unit_id, service_id, professional_id,
         starts_at, ends_at, status, capacity, appointment_type)
       VALUES ($1, $2, $3, $4, $5,
               '2026-08-24 10:00:00-03', '2026-08-24 10:50:00-03',
               'completed', 1, 'individual')`,
      [sourceAppointmentId, organizationId,
        'aaaaaaaa-1000-4000-8000-000000000001',
        'aaaaaaaa-6100-4000-8000-000000000001',
        'aaaaaaaa-4000-4000-8000-000000000001'],
    )
    await db.query(
      `INSERT INTO appointment_participants
        (id, organization_id, appointment_id, client_id, status)
       VALUES ($1, $2, $3, $4, 'absent')`,
      [sourceParticipantId, organizationId, sourceAppointmentId, linkedClientId],
    )

    const issued = await repository.issueReplacementCredit({
      actorUserId: ownerA, organizationId, clientId: linkedClientId,
      sourceParticipantId, expiresOn: '2026-11-30',
    })
    const repeatedIssue = await repository.issueReplacementCredit({
      actorUserId: ownerA, organizationId, clientId: linkedClientId,
      sourceParticipantId, expiresOn: '2026-11-30',
    })
    expect(repeatedIssue.id).toBe(issued.id)

    const target = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2026-11-16T10:00:00-03:00'), capacity: 2,
        clientIds: [], equipment: [],
      },
    })
    const before = await repository.getOwnReplacementCredits({
      actorUserId: clientUserId, organizationId,
    })
    expect(before).toMatchObject({
      balance: 1,
      credits: expect.arrayContaining([expect.objectContaining({ id: issued.id, status: 'available' })]),
      eligibleAppointments: expect.arrayContaining([expect.objectContaining({ id: target.id })]),
    })

    const booked = await repository.bookOwnAppointmentWithReplacement({
      actorUserId: clientUserId, organizationId, appointmentId: target.id,
    })
    const repeatedBooking = await repository.bookOwnAppointmentWithReplacement({
      actorUserId: clientUserId, organizationId, appointmentId: target.id,
    })
    expect(booked).toMatchObject({
      id: target.id, participantStatus: 'confirmed', replacementCreditId: issued.id,
    })
    expect(repeatedBooking.participantId).toBe(booked.participantId)

    const after = await repository.getOwnReplacementCredits({
      actorUserId: clientUserId, organizationId,
    })
    expect(after.balance).toBe(0)
    expect(after.credits.find(({ id }) => id === issued.id)).toMatchObject({
      id: issued.id, status: 'consumed',
      consumption: { participantId: booked.participantId, appointmentId: target.id },
    })
    const targetWithoutCredit = await repository.createClassAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2026-11-23T10:00:00-03:00'), capacity: 2,
        clientIds: [], equipment: [],
      },
    })
    await expect(repository.bookOwnAppointmentWithReplacement({
      actorUserId: clientUserId, organizationId,
      appointmentId: targetWithoutCredit.id,
    })).rejects.toMatchObject({ code: 'REPLACEMENT_CREDIT_REQUIRED' })

    const effects = await db.query(
      `SELECT
         (SELECT count(*)::int FROM replacement_credit_status_history
          WHERE organization_id = $1 AND replacement_credit_id = $2) AS history,
         (SELECT count(*)::int FROM audit_events
          WHERE organization_id = $1 AND target_id = $2) AS audits,
         (SELECT count(*)::int FROM outbox_events
          WHERE organization_id = $1 AND aggregate_id = $2) AS events`,
      [organizationId, issued.id],
    )
    expect(effects.rows[0]).toEqual({ history: 2, audits: 2, events: 2 })
    await expect(db.query(
      `UPDATE replacement_credits SET status = 'available', consumed_at = NULL,
              consumed_by_participant_id = NULL
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, issued.id],
    )).rejects.toThrow(/terminal state is immutable/)
    await expect(db.query(
      'DELETE FROM replacement_credit_status_history WHERE replacement_credit_id = $1',
      [issued.id],
    )).rejects.toThrow(/append-only/)
  })

  it('registra dispositivo e materializa uma única entrega para a oferta ativa da Outbox', async () => {
    const waitingClient = 'aaaaaaaa-5000-4000-8000-000000000021'
    await db.query('UPDATE clients SET user_id = $2 WHERE id = $1', [waitingClient, ownerA])
    try {
      const device = await repository.registerPushDevice({
        userId: ownerA,
        platform: 'android',
        tokenCiphertext: 'ciphertext.synthetic.push.token',
        tokenFingerprint: 'fingerprint-synthetic-push-token',
      })
      expect(device).toMatchObject({ platform: 'android', active: true })

      expect(await repository.listNotificationPreferences({
        userId: ownerA,
        organizationId: organizationA,
        eventTypes: ['waitlist.offer.created'],
      })).toEqual([{ eventType: 'waitlist.offer.created', enabled: true }])
      await repository.updateNotificationPreference({
        userId: ownerA, organizationId: organizationA,
        eventType: 'waitlist.offer.created', enabled: true,
      })

      const claimed = await repository.claimPushOutboxEvents({ workerId: 'worker-test', limit: 20 })
      const activeEvent = claimed.find(({ recipientUserId }) => recipientUserId === ownerA)
      expect(activeEvent).toBeTruthy()
      const firstPreparation = await repository.preparePushDeliveries({
        event: activeEvent, templateKey: 'waitlist_offer_available',
      })
      const repeatedPreparation = await repository.preparePushDeliveries({
        event: activeEvent, templateKey: 'waitlist_offer_available',
      })
      expect(firstPreparation).toHaveLength(1)
      expect(repeatedPreparation).toEqual(firstPreparation)

      await repository.markPushDeliverySent({
        event: activeEvent,
        deliveryId: firstPreparation[0].id,
        messageId: 'projects/test/messages/1',
      })
      await repository.finishPushOutboxEvent({ eventId: activeEvent.id, workerId: 'worker-test' })

      const persisted = await db.query(
        `SELECT notification.status, delivery.status AS delivery_status,
                delivery.attempt_count, event.processed_at IS NOT NULL AS processed
         FROM outbox_events event
         JOIN notifications notification ON notification.outbox_event_id = event.id
         JOIN push_deliveries delivery ON delivery.notification_id = notification.id
         WHERE event.id = $1`,
        [activeEvent.id],
      )
      expect(persisted.rows).toEqual([{
        status: 'sent', delivery_status: 'sent', attempt_count: 1, processed: true,
      }])
    } finally {
      await db.query('UPDATE clients SET user_id = NULL WHERE id = $1', [waitingClient])
    }
  })

  it('cria série para cliente fixo e altera uma ocorrência ou as futuras', async () => {
    const organizationId = organizationA
    const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
    const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
    const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const occurrences = [
      new Date('2026-10-13T09:00:00-03:00'),
      new Date('2026-10-20T09:00:00-03:00'),
      new Date('2026-10-27T09:00:00-03:00'),
    ]
    await expect(repository.createAppointmentSeries({
      actorUserId: ownerA, organizationId,
      series: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000002',
        professionalId, unitId, serviceId, roomId: null,
        timezone: 'America/Sao_Paulo', interval: 1,
        occurrences: [new Date('2026-11-10T09:00:00-03:00'), new Date('2026-11-17T09:00:00-03:00')],
        seriesStart: '2026-11-10', seriesEnd: '2026-11-17',
        recurrenceExpression: 'FREQ=WEEKLY;INTERVAL=1;COUNT=2',
      },
    })).rejects.toMatchObject({ code: '23514' })

    const series = await repository.createAppointmentSeries({
      actorUserId: ownerA, organizationId,
      series: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        timezone: 'America/Sao_Paulo', interval: 1, occurrences,
        seriesStart: '2026-10-13', seriesEnd: '2026-10-27',
        recurrenceExpression: 'FREQ=WEEKLY;INTERVAL=1;COUNT=3',
      },
    })
    expect(series.appointments).toHaveLength(3)
    expect(series.appointments[2].recurrence).toMatchObject({ occurrenceIndex: 2, count: 3 })

    const single = await repository.updateAppointmentOccurrences({
      actorUserId: ownerA, organizationId, appointmentId: series.appointments[0].id, scope: 'single',
      appointment: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-10-13T10:00:00-03:00'),
      },
    })
    expect(single.appointments).toHaveLength(1)
    expect(single.appointments[0].startsAt).toEqual(new Date('2026-10-13T13:00:00.000Z'))

    const future = await repository.updateAppointmentOccurrences({
      actorUserId: ownerA, organizationId, appointmentId: series.appointments[1].id, scope: 'future',
      appointment: {
        clientId, professionalId, unitId, serviceId, roomId: null,
        startsAt: new Date('2026-10-20T11:00:00-03:00'),
      },
    })
    expect(future.appointments).toHaveLength(2)
    expect(future.appointments.map(({ startsAt }) => startsAt)).toEqual([
      new Date('2026-10-20T14:00:00.000Z'), new Date('2026-10-27T14:00:00.000Z'),
    ])
  })

  it('associa sala e aparelhos e relata conflitos por recurso', async () => {
    const organizationId = organizationA
    const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
    const otherProfessionalId = 'aaaaaaaa-4000-4000-8000-000000000098'
    const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
    const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
    const roomId = 'aaaaaaaa-6200-4000-8000-000000000001'
    const equipmentId = 'aaaaaaaa-6250-4000-8000-000000000001'

    await db.query(
      `INSERT INTO professionals (id, organization_id, display_name)
       VALUES ($1, $2, 'Profissional Sintético Recursos')`,
      [otherProfessionalId, organizationId],
    )
    await db.query(
      `INSERT INTO availability_rules
        (organization_id, professional_id, unit_id, rule_type, kind, weekday,
         local_start_time, local_end_time, timezone, label)
       VALUES ($1, $2, $3, 'available', 'working_hours', 3,
               '07:00', '19:00', 'America/Sao_Paulo', 'Expediente recursos')`,
      [organizationId, otherProfessionalId, unitId],
    )

    const allocated = await repository.createAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000001', professionalId, unitId,
        serviceId, roomId, startsAt: new Date('2026-09-09T09:00:00-03:00'),
        equipment: [{ equipmentId, quantity: 3 }],
      },
    })
    expect(allocated).toMatchObject({
      room: { id: roomId },
      equipment: [{ id: equipmentId, name: 'Reformer Sintético', quantity: 3 }],
    })

    await expect(repository.createAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000002', professionalId: otherProfessionalId,
        unitId, serviceId, roomId, startsAt: new Date('2026-09-09T09:10:00-03:00'), equipment: [],
      },
    })).rejects.toMatchObject({ code: '23P01', message: expect.stringContaining('room appointment') })

    await expect(repository.createAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000002', professionalId: otherProfessionalId,
        unitId, serviceId, roomId: null, startsAt: new Date('2026-09-09T09:10:00-03:00'),
        equipment: [{ equipmentId, quantity: 2 }],
      },
    })).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('equipment capacity') })
  })

  it('registra presença com transição válida, histórico imutável e auditoria', async () => {
    const organizationId = organizationA
    const created = await repository.createAppointment({
      actorUserId: ownerA, organizationId,
      appointment: {
        clientId: 'aaaaaaaa-5000-4000-8000-000000000002',
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
        serviceId: 'aaaaaaaa-6100-4000-8000-000000000001', roomId: null,
        startsAt: new Date('2026-08-31T09:00:00-03:00'), equipment: [],
      },
    })
    const participantId = created.participants[0].id
    const attended = await repository.updateAppointmentParticipantStatus({
      actorUserId: ownerA, organizationId, appointmentId: created.id,
      participantId, status: 'attended', reason: null,
    })
    expect(attended).toMatchObject({
      status: 'completed',
      participants: [expect.objectContaining({ status: 'attended' })],
    })
    expect(attended.participants[0].history.map(({ toStatus }) => toStatus))
      .toEqual(['confirmed', 'attended'])

    await expect(repository.updateAppointmentParticipantStatus({
      actorUserId: ownerA, organizationId, appointmentId: created.id,
      participantId, status: 'absent', reason: null,
    })).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(
      'DELETE FROM appointment_participant_status_history WHERE participant_id = $1',
      [participantId],
    )).rejects.toThrow(/append-only/)

    const audit = await db.query(
      `SELECT action, minimal_metadata FROM audit_events
       WHERE organization_id = $1 AND target_id = $2`,
      [organizationId, participantId],
    )
    expect(audit.rows).toEqual([
      expect.objectContaining({
        action: 'participant.attended',
        minimal_metadata: expect.objectContaining({ fromStatus: 'confirmed', toStatus: 'attended' }),
      }),
    ])
  })

  it('expõe somente avaliações e treinos publicados do cliente e canais oficiais da clínica', async () => {
    const clientUser = '00000000-0000-4000-8000-000000000004'
    const content = await repository.getOwnPublishedClinicalContent({
      actorUserId: clientUser, organizationId: organizationA,
    })
    expect(content.assessments).toHaveLength(1)
    expect(content.assessments[0]).toMatchObject({
      id: 'aaaaaaaa-5100-4000-8000-000000000001', type: 'Avaliação funcional',
    })
    expect(content.workoutPlans).toHaveLength(1)
    expect(content.workoutPlans[0]).toMatchObject({
      id: 'aaaaaaaa-5200-4000-8000-000000000001', title: 'Treino sintético de mobilidade',
    })

    const contact = await repository.getOwnContactChannels({
      actorUserId: clientUser, organizationId: organizationA,
    })
    expect(contact.channels).toEqual([
      expect.objectContaining({ channel: 'whatsapp', href: 'https://wa.me/5547999990000' }),
      expect.objectContaining({ channel: 'email', href: 'mailto:contato@clinica-demo.invalid' }),
    ])
    expect(JSON.stringify({ content, contact })).not.toContain('Não deve aparecer')
    expect(JSON.stringify({ content, contact })).not.toContain('Conteúdo de outro cliente')
  })

  it('isola a área do cliente e faz auto check-in uma única vez dentro da política', async () => {
    const clientUser = '00000000-0000-4000-8000-000000000004'
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    await db.query(
      `UPDATE appointments SET starts_at = now(), ends_at = now() + interval '50 minutes', status = 'scheduled'
       WHERE organization_id = $1 AND id = $2`,
      [organizationA, appointmentId],
    )

    const area = await repository.getClientArea({ actorUserId: clientUser, organizationId: organizationA })
    expect(area).toMatchObject({
      client: { id: 'aaaaaaaa-5000-4000-8000-000000000001' },
      checkInPolicy: { enabled: true, beforeMinutes: 30, afterMinutes: 15 },
      nextAppointment: { id: appointmentId },
    })
    const own = await repository.getOwnAppointments({ actorUserId: clientUser, organizationId: organizationA })
    expect(own.appointments).toContainEqual(
      expect.objectContaining({ id: appointmentId, checkIn: expect.objectContaining({ allowed: true }) }),
    )

    const first = await repository.selfCheckIn({
      actorUserId: clientUser, organizationId: organizationA, appointmentId,
    })
    const repeated = await repository.selfCheckIn({
      actorUserId: clientUser, organizationId: organizationA, appointmentId,
    })
    expect(first.checkedInAt).toBeTruthy()
    expect(repeated.checkedInAt).toEqual(first.checkedInAt)
    const stored = await db.query(
      `SELECT count(*)::int AS count FROM checkins WHERE organization_id = $1`, [organizationA],
    )
    expect(stored.rows[0].count).toBe(1)
    const audit = await db.query(
      `SELECT count(*)::int AS count FROM audit_events
       WHERE organization_id = $1 AND action = 'client.check_in'`, [organizationA],
    )
    expect(audit.rows[0].count).toBe(1)

    const future = own.appointments.find((item) => item.id !== appointmentId
      && item.status === 'scheduled' && new Date(item.startsAt).getTime() > Date.now() + 86_400_000)
    expect(future).toBeTruthy()
    await expect(repository.selfCheckIn({
      actorUserId: clientUser, organizationId: organizationA, appointmentId: future.id,
    })).rejects.toMatchObject({ code: 'CHECKIN_TOO_EARLY' })
    await db.query(
      'UPDATE organizations SET self_checkin_enabled = false WHERE id = $1', [organizationA],
    )
    await expect(repository.selfCheckIn({
      actorUserId: clientUser, organizationId: organizationA, appointmentId: future.id,
    })).rejects.toMatchObject({ code: 'SELF_CHECKIN_DISABLED' })

    const anotherClientsAppointment = await db.query(
      `SELECT appointment_id FROM appointment_participants
       WHERE organization_id = $1 AND client_id = $2 LIMIT 1`,
      [organizationA, 'aaaaaaaa-5000-4000-8000-000000000002'],
    )
    await expect(repository.selfCheckIn({
      actorUserId: clientUser, organizationId: organizationA,
      appointmentId: anotherClientsAppointment.rows[0].appointment_id,
    })).rejects.toMatchObject({ code: 'APPOINTMENT_NOT_FOUND' })

    await expect(repository.getOwnAppointments({ actorUserId: ownerA, organizationId: organizationA }))
      .rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_FOUND' })
  })

  it('cria recorrência idempotente, concilia estados e preserva cancelamento no histórico', async () => {
    const input = {
      description: 'Série financeira de teste',
      clientId: 'aaaaaaaa-5000-4000-8000-000000000001',
      categoryId: 'aaaaaaaa-7100-4000-8000-000000000001',
      amountCents: 31000,
      currency: 'BRL',
      dueOn: '2027-01-31',
      competenceOn: '2027-01-01',
      idempotencyKey: 'test:fin-002:monthly-series',
      recurrence: { frequency: 'monthly', installmentCount: 3 },
    }
    const created = await repository.createReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivable: input,
    })
    expect(created.replayed).toBe(false)
    expect(created.items.map(({ dueOn }) => dueOn)).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31',
    ])
    expect(created.items.map(({ installmentNumber }) => installmentNumber)).toEqual([1, 2, 3])

    const replay = await repository.createReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivable: input,
    })
    expect(replay).toMatchObject({ replayed: true })
    expect(replay.items).toHaveLength(3)

    const first = created.items[0]
    const updated = await repository.updateReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId: first.id,
      receivable: { ...input, description: 'Parcela ajustada', amountCents: 30000 },
    })
    expect(updated).toMatchObject({ description: 'Parcela ajustada', originalAmountCents: 30000 })

    const cancelled = await repository.cancelReceivable({
      actorUserId: ownerA, organizationId: organizationA,
      receivableId: created.items[1].id, reason: 'Série ajustada pela recepção',
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', balanceCents: 31000 })

    await db.query(
      `INSERT INTO payments
        (organization_id, receivable_id, amount_cents, method, paid_at, idempotency_key)
       VALUES ($1, $2, 10000, 'pix', '2026-09-15 10:00:00-03', 'test:fin-002:payment')`,
      [organizationA, created.items[2].id],
    )
    const partial = await repository.getReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId: created.items[2].id,
    })
    expect(partial).toMatchObject({ status: 'partially_paid', paidAmountCents: 10000, balanceCents: 21000 })
    await expect(repository.cancelReceivable({
      actorUserId: ownerA, organizationId: organizationA,
      receivableId: created.items[2].id, reason: 'Não deve cancelar',
    })).rejects.toMatchObject({ code: 'RECEIVABLE_HAS_PAYMENTS' })

    const detail = await repository.getReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId: first.id,
    })
    expect(detail.history.map(({ action }) => action)).toEqual([
      'receivable.updated', 'receivable.created',
    ])
  })

  it('registra recebimento parcial e estorno idempotentes preservando todos os lançamentos', async () => {
    const account = await repository.createReceivable({
      actorUserId: ownerA, organizationId: organizationA,
      receivable: {
        description: 'Recebível para FIN-003',
        clientId: 'aaaaaaaa-5000-4000-8000-000000000001',
        categoryId: 'aaaaaaaa-7100-4000-8000-000000000001',
        amountCents: 40000, currency: 'BRL', dueOn: '2027-04-10', competenceOn: '2027-04-01',
        idempotencyKey: 'test:fin-003:receivable', recurrence: null,
      },
    })
    const receivableId = account.items[0].id
    const input = {
      amountCents: 15000, method: 'pix', externalReference: null,
      paidAt: '2027-04-02T12:00:00.000Z', idempotencyKey: 'test:fin-003:payment',
    }
    const recorded = await repository.createReceivablePayment({
      actorUserId: ownerA, organizationId: organizationA, receivableId, payment: input,
    })
    expect(recorded).toMatchObject({ replayed: false, payment: { amountCents: 15000 } })
    expect(await repository.createReceivablePayment({
      actorUserId: ownerA, organizationId: organizationA, receivableId, payment: input,
    })).toMatchObject({ replayed: true, payment: { id: recorded.payment.id } })
    expect(await repository.getReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
    })).toMatchObject({ status: 'partially_paid', paidAmountCents: 15000, balanceCents: 25000 })
    await expect(repository.createReceivablePayment({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
      payment: { ...input, amountCents: 25001, idempotencyKey: 'test:fin-003:overpayment' },
    })).rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_BALANCE' })

    await repository.reverseReceivablePayment({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
      paymentId: recorded.payment.id,
      reversal: { reason: 'Pagamento lançado em duplicidade', reversedAt: '2027-04-03T12:00:00.000Z', idempotencyKey: 'test:fin-003:reversal' },
    })
    const detail = await repository.getReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
    })
    expect(detail).toMatchObject({ status: 'open', paidAmountCents: 0, balanceCents: 40000 })
    expect(detail.payments).toHaveLength(2)
    expect(detail.history.map(({ action }) => action)).toEqual(expect.arrayContaining([
      'receivable.payment.recorded', 'receivable.payment.reversed',
    ]))
    const edited = await repository.updateReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
      receivable: {
        description: 'Recebível para FIN-003 ajustado',
        clientId: 'aaaaaaaa-5000-4000-8000-000000000001',
        categoryId: 'aaaaaaaa-7100-4000-8000-000000000001',
        amountCents: 40000, dueOn: '2027-04-10', competenceOn: '2027-04-01',
      },
    })
    expect(edited).toMatchObject({ description: 'Recebível para FIN-003 ajustado', status: 'open' })
    const cancelled = await repository.cancelReceivable({
      actorUserId: ownerA, organizationId: organizationA, receivableId,
      reason: 'Cancelada depois do estorno',
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', balanceCents: 40000 })
  })

  it('cria despesas recorrentes, categorias, baixas e estornos com auditoria', async () => {
    const category = await repository.createFinancialCategory({
      actorUserId: ownerA, organizationId: organizationA,
      category: { kind: 'payable', name: 'Impostos sintéticos' },
    })
    const created = await repository.createPayable({
      actorUserId: ownerA, organizationId: organizationA,
      payable: {
        categoryId: category.id, counterparty: 'Prefeitura Sintética', description: 'Taxa mensal',
        amountCents: 12000, currency: 'BRL', dueOn: '2027-05-31', competenceOn: '2027-05-01',
        idempotencyKey: 'test:fin-004:series', recurrence: { frequency: 'monthly', installmentCount: 2 },
      },
    })
    expect(created.items.map(({ dueOn }) => dueOn)).toEqual(['2027-05-31', '2027-06-30'])
    expect(await repository.createPayable({
      actorUserId: ownerA, organizationId: organizationA,
      payable: {
        categoryId: category.id, counterparty: 'Prefeitura Sintética', description: 'Taxa mensal',
        amountCents: 12000, currency: 'BRL', dueOn: '2027-05-31', competenceOn: '2027-05-01',
        idempotencyKey: 'test:fin-004:series', recurrence: { frequency: 'monthly', installmentCount: 2 },
      },
    })).toMatchObject({ replayed: true })
    const payableId = created.items[0].id
    const payment = await repository.createPayablePayment({
      actorUserId: ownerA, organizationId: organizationA, payableId,
      payment: { amountCents: 5000, method: 'transfer', externalReference: 'SYNTHETIC-1', paidAt: '2027-05-20T12:00:00.000Z', idempotencyKey: 'test:fin-004:payment' },
    })
    expect(await repository.getPayable({ actorUserId: ownerA, organizationId: organizationA, payableId }))
      .toMatchObject({ status: 'partially_paid', paidAmountCents: 5000, balanceCents: 7000 })
    await repository.reversePayablePayment({
      actorUserId: ownerA, organizationId: organizationA, payableId, paymentId: payment.payment.id,
      reversal: { reason: 'Baixa no fornecedor incorreto', reversedAt: '2027-05-21T12:00:00.000Z', idempotencyKey: 'test:fin-004:reversal' },
    })
    const detail = await repository.getPayable({ actorUserId: ownerA, organizationId: organizationA, payableId })
    expect(detail).toMatchObject({ status: 'open', paidAmountCents: 0, balanceCents: 12000 })
    expect(detail.payments).toHaveLength(2)
    expect(detail.history.map(({ action }) => action)).toEqual(expect.arrayContaining([
      'payable.created', 'payable.payment.recorded', 'payable.payment.reversed',
    ]))
    const edited = await repository.updatePayable({
      actorUserId: ownerA, organizationId: organizationA, payableId,
      payable: {
        categoryId: category.id, counterparty: 'Prefeitura Sintética', description: 'Taxa mensal ajustada',
        amountCents: 12000, dueOn: '2027-05-31', competenceOn: '2027-05-01',
      },
    })
    expect(edited).toMatchObject({ description: 'Taxa mensal ajustada', status: 'open' })
    const cancelled = await repository.cancelPayable({
      actorUserId: ownerA, organizationId: organizationA, payableId,
      reason: 'Cancelada depois do estorno',
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', balanceCents: 12000 })
  })

  it('filtra aniversariantes e protege o contato conforme consentimento', async () => {
    const catalog = await repository.getReportFilters({
      actorUserId: ownerA, organizationId: organizationA,
    })
    expect(catalog.units.length).toBeGreaterThan(0)
    expect(catalog.professionals.length).toBeGreaterThan(0)

    const permitted = await repository.listBirthdayReport({
      actorUserId: ownerA,
      organizationId: organizationA,
      from: '2027-01-01',
      to: '2027-01-01',
      status: 'active',
      page: 1,
      pageSize: 25,
    })
    expect(permitted.total).toBe(1)
    expect(permitted.items[0]).toMatchObject({
      fullName: 'Cliente Sintético 001',
      occursOn: '2027-01-01',
      contactAllowed: true,
      preferredContact: { type: 'email', value: 'cliente.001@example.invalid' },
    })

    await db.query(
      `UPDATE client_consents SET revoked_at = now()
       WHERE organization_id = $1 AND client_id = $2 AND purpose = 'birthday_contact'`,
      [organizationA, 'aaaaaaaa-5000-4000-8000-000000000001'],
    )
    const revoked = await repository.listBirthdayReport({
      actorUserId: ownerA,
      organizationId: organizationA,
      from: '2027-01-01',
      to: '2027-01-01',
      page: 1,
      pageSize: 25,
    })
    expect(revoked.items[0]).toMatchObject({ contactAllowed: false, preferredContact: null })
    await db.query(
      `UPDATE client_consents SET revoked_at = NULL
       WHERE organization_id = $1 AND client_id = $2 AND purpose = 'birthday_contact'`,
      [organizationA, 'aaaaaaaa-5000-4000-8000-000000000001'],
    )

    await expect(repository.listBirthdayReport({
      actorUserId: professionalA,
      organizationId: organizationA,
      from: '2027-01-01',
      to: '2027-01-01',
      page: 1,
      pageSize: 25,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('concilia clientes gerais/fixos e detalha atividade mensal pela presença', async () => {
    await db.query("SELECT set_config('app.organization_id', $1, false)", [organizationA])
    await db.query(
      `UPDATE clients SET created_at = CASE
         WHEN id IN (
           'aaaaaaaa-5000-4000-8000-000000000001',
           'aaaaaaaa-5000-4000-8000-000000000002'
         ) THEN '2026-09-03 12:00:00+00'::timestamptz
         ELSE '2020-01-01 12:00:00+00'::timestamptz
       END
       WHERE organization_id = $1`,
      [organizationA],
    )
    await db.query(
      `INSERT INTO appointments
        (id, organization_id, unit_id, service_id, professional_id, room_id,
         starts_at, ends_at, capacity, appointment_type, status)
       VALUES
        ('aaaaaaaa-6300-4000-8000-000000000199', $1,
         'aaaaaaaa-1000-4000-8000-000000000001',
         'aaaaaaaa-6100-4000-8000-000000000001',
         'aaaaaaaa-4000-4000-8000-000000000001',
         'aaaaaaaa-6200-4000-8000-000000000001',
         '2026-09-02 13:00:00-03', '2026-09-02 13:50:00-03', 4, 'class', 'scheduled')
       ON CONFLICT DO NOTHING`,
      [organizationA],
    )
    await db.query(
      `INSERT INTO appointment_participants
        (id, organization_id, appointment_id, client_id, status)
       VALUES
        ('aaaaaaaa-6400-4000-8000-000000000199', $1,
         'aaaaaaaa-6300-4000-8000-000000000199',
         'aaaaaaaa-5000-4000-8000-000000000001', 'attended')
       ON CONFLICT DO NOTHING`,
      [organizationA],
    )
    await db.query(
      `UPDATE appointments SET status = 'completed'
       WHERE organization_id = $1 AND id = 'aaaaaaaa-6300-4000-8000-000000000199'`,
      [organizationA],
    )
    await db.query(
      `INSERT INTO appointment_equipment
        (organization_id, appointment_id, equipment_id, quantity)
       VALUES ($1, 'aaaaaaaa-6300-4000-8000-000000000199',
               'aaaaaaaa-6250-4000-8000-000000000001', 2)
       ON CONFLICT DO NOTHING`,
      [organizationA],
    )

    const fixed = await repository.listClientReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2026-09-01', to: '2026-09-30', clientType: 'fixed', page: 1, pageSize: 25,
    })
    expect(fixed.totals).toMatchObject({ total: 1, fixed: 1, rotating: 0 })
    expect(fixed.items[0]).toMatchObject({
      fullName: 'Cliente Sintético 001', plan: { name: 'Plano Sintético Mensal' },
    })

    const activity = await repository.listClientActivityReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2026-09-01', to: '2026-09-30', granularity: 'month',
      bucket: '2026-09', page: 1, pageSize: 25,
    })
    expect(activity.items).toEqual([expect.objectContaining({
      period: '2026-09', activeClients: 1, attendances: 1,
    })])
    expect(activity.detailTotal).toBe(1)
    expect(activity.details[0]).toMatchObject({
      fullName: 'Cliente Sintético 001', attendances: 1, lastAttendanceOn: '2026-09-02',
    })

    const dashboard = await repository.getBusinessDashboardReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2026-09-01', to: '2026-09-30',
    })
    expect(dashboard.financial).toEqual({
      billedCents: 25000, receivedCents: 15000, outstandingCents: 20000,
    })
    expect(dashboard.operational).toMatchObject({
      completedAppointments: 1, attendances: 1, absences: 0,
      attendanceRate: 100,
    })
    expect(dashboard.operational.appointments).toBeGreaterThanOrEqual(2)

    const equipment = await repository.listEquipmentUsageReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2026-09-01', to: '2026-09-30',
      modalityId: 'aaaaaaaa-6000-4000-8000-000000000001', page: 1, pageSize: 25,
    })
    expect(equipment.totals).toEqual({
      equipmentTypes: 1, appointments: 1, allocatedQuantity: 2,
    })
    expect(equipment.items[0]).toMatchObject({
      equipmentName: 'Reformer Sintético', modalityName: 'Modalidade Sintética',
      appointments: 1, allocatedQuantity: 2, attendances: 1, lastUsedOn: '2026-09-02',
    })
  })

  it('concilia conversão, perdas, origem, etapa e tempo de ciclo das prospecções', async () => {
    await db.query(
      `INSERT INTO prospects
        (id, organization_id, owner_professional_id, converted_client_id, full_name,
         stage, source, converted_at, created_at, updated_at)
       VALUES
        ('aaaaaaaa-5200-4000-8000-000000000097', $1,
         'aaaaaaaa-4000-4000-8000-000000000001',
         'aaaaaaaa-5000-4000-8000-000000000001', 'Prospect Convertida',
         'converted', 'Indicação', '2028-03-05 09:00:00+00',
         '2028-03-01 09:00:00+00', '2028-03-05 09:00:00+00'),
        ('aaaaaaaa-5200-4000-8000-000000000098', $1,
         'aaaaaaaa-4000-4000-8000-000000000001', NULL, 'Prospect Perdida',
         'lost', 'Instagram', NULL,
         '2028-03-02 09:00:00+00', '2028-03-07 09:00:00+00'),
        ('aaaaaaaa-5200-4000-8000-000000000099', $1,
         NULL, NULL, 'Prospect em Proposta',
         'proposal', 'Indicação', NULL,
         '2028-03-03 09:00:00+00', '2028-03-04 09:00:00+00')`,
      [organizationA],
    )
    await db.query(
      `INSERT INTO prospect_interactions
        (id, organization_id, prospect_id, type, notes, occurred_at)
       VALUES
        ('aaaaaaaa-5220-4000-8000-000000000098', $1,
         'aaaaaaaa-5200-4000-8000-000000000098', 'stage_change', NULL,
         '2028-03-07 09:00:00+00')`,
      [organizationA],
    )

    const report = await repository.listProspectReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2028-03-01', to: '2028-03-31', page: 1, pageSize: 25,
    })

    expect(report.totals).toEqual({
      total: 3, converted: 1, lost: 1, open: 1,
      conversionRate: 33.3, lossRate: 33.3, averageCycleDays: 4.5,
    })
    expect(report.stages).toMatchObject({ proposal: 1, lost: 1, converted: 1 })
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'Indicação', total: 2, converted: 1, conversionRate: 50 }),
      expect.objectContaining({ source: 'Instagram', total: 1, lost: 1 }),
    ]))
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fullName: 'Prospect Convertida', closedOn: '2028-03-05', cycleDays: 4 }),
      expect.objectContaining({ fullName: 'Prospect Perdida', closedOn: '2028-03-07', cycleDays: 5 }),
      expect.objectContaining({ fullName: 'Prospect em Proposta', closedOn: null, cycleDays: null }),
    ]))

    const unitScoped = await repository.listProspectReport({
      actorUserId: ownerA, organizationId: organizationA,
      from: '2028-03-01', to: '2028-03-31',
      unitId: 'aaaaaaaa-1000-4000-8000-000000000001', status: 'active',
      page: 1, pageSize: 25,
    })
    expect(unitScoped.totals.total).toBe(1)
    expect(unitScoped.items[0]).toMatchObject({ fullName: 'Prospect Convertida', stage: 'converted' })
  })

  it('possui rollback para todas as migrations', async () => {
    const rollbackDb = await PGlite.create()
    try {
      await rollbackDb.exec(`
        CREATE ROLE clinicflow_app
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      `)
      for (const migration of migrations) await rollbackDb.exec(migration.up)
      for (const migration of [...migrations].reverse()) await rollbackDb.exec(migration.down)
      const tables = await rollbackDb.query(`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `)
      expect(tables.rows[0].count).toBe(0)
    } finally {
      await rollbackDb.close()
    }
  }, 30_000)
})
