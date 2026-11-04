// @vitest-environment node

import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService } from '../server/auth-service.mjs'
import { PostgresAuthRepository } from '../server/postgres-auth-repository.mjs'
import { readDevelopmentSeed, readMigrations } from '../scripts/db/files.mjs'

const { Pool } = pg
const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001'
const ownerUserId = '00000000-0000-4000-8000-000000000001'
const professionalId = 'aaaaaaaa-4000-4000-8000-000000000001'
const unitId = 'aaaaaaaa-1000-4000-8000-000000000001'
const serviceId = 'aaaaaaaa-6100-4000-8000-000000000001'
const fixedClientId = 'aaaaaaaa-5000-4000-8000-000000000001'
const clientUserId = '00000000-0000-4000-8000-000000000004'
const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
const sourceDatabaseUrl = process.env.QA_DATABASE_URL ?? process.env.DATABASE_URL
const scheduleQaRequested = process.env.npm_lifecycle_event === 'test:qa:schedule'
  || process.argv.some((argument) => argument.includes('schedule-qa.integration.test.mjs'))

function quoteIdentifier(value) {
  if (!/^clinicflow_qa_002_[a-z0-9_]+$/u.test(value)) {
    throw new Error(`Nome de banco temporário recusado: ${value}`)
  }
  return `"${value}"`
}

function testDatabaseUrl(sourceUrl, databaseName) {
  const url = new URL(sourceUrl)
  url.pathname = `/${databaseName}`
  url.searchParams.set('application_name', 'clinicflow-qa-002')
  return url.toString()
}

function assertLocalDatabase(sourceUrl) {
  const url = new URL(sourceUrl)
  if (!localHosts.has(url.hostname) || process.env.NODE_ENV === 'production') {
    throw new Error('QA-002 requer um PostgreSQL local e não produtivo.')
  }
}

async function waitForLockWaiters(pool, expected, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'clinicflow-qa-002'
        AND wait_event_type = 'Lock'
    `)
    if (result.rows[0].count >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`As ${expected} reservas concorrentes não chegaram juntas ao bloqueio.`)
}

function localTimeParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  return Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]),
  )
}

describe.skipIf(!sourceDatabaseUrl || !scheduleQaRequested)(
  'QA-002 — concorrência e fusos no PostgreSQL real', () => {
  let adminPool
  let pool
  let repository
  let service
  let databaseName

  async function dropTemporaryDatabase() {
    if (!adminPool || !databaseName) return
    quoteIdentifier(databaseName)
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
  }

  beforeAll(async () => {
    assertLocalDatabase(sourceDatabaseUrl)
    databaseName = `clinicflow_qa_002_${process.pid}_${randomBytes(5).toString('hex')}`
    adminPool = new Pool({ connectionString: sourceDatabaseUrl, max: 2 })
    try {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`)
      pool = new Pool({ connectionString: testDatabaseUrl(sourceDatabaseUrl, databaseName), max: 12 })
      for (const migration of await readMigrations()) await pool.query(migration.up)
      await pool.query('BEGIN')
      try {
        await pool.query(await readDevelopmentSeed())
        await pool.query('COMMIT')
      } catch (error) {
        await pool.query('ROLLBACK')
        throw error
      }
      repository = new PostgresAuthRepository('postgresql://unused', { pool })
      const session = {
        user: { id: ownerUserId, email: 'proprietario.a@example.invalid' },
        organizationId,
        organizations: [{ id: organizationId, permissions: ['schedule.manage'] }],
      }
      service = new AuthService({
        getSession: async () => session,
        createAppointment: (input) => repository.createAppointment(input),
        createClassAppointment: (input) => repository.createClassAppointment(input),
        addAppointmentParticipant: (input) => repository.addAppointmentParticipant(input),
        createAppointmentSeries: (input) => repository.createAppointmentSeries(input),
      }, { mfaEncryptionKey: Buffer.alloc(32) })
    } catch (error) {
      if (pool) await pool.end().catch(() => undefined)
      pool = null
      await dropTemporaryDatabase().catch(() => undefined)
      databaseName = null
      if (adminPool) await adminPool.end().catch(() => undefined)
      adminPool = null
      throw error
    }
  }, 60_000)

  afterAll(async () => {
    if (pool) await pool.end()
    pool = null
    await dropTemporaryDatabase()
    databaseName = null
    if (adminPool) await adminPool.end()
    adminPool = null
  }, 30_000)

  it('serializa duas reservas simultâneas para a última vaga', async () => {
    const clientIds = [
      'aaaaaaaa-5000-4000-8000-000000000021',
      'aaaaaaaa-5000-4000-8000-000000000022',
      'aaaaaaaa-5000-4000-8000-000000000023',
    ]
    for (const [index, clientId] of clientIds.entries()) {
      await pool.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético QA-002 ${index + 1}`],
      )
    }

    const appointment = await service.createClassAppointment('qa-session', organizationId, {
      professionalId, unitId, serviceId, roomId: null, equipment: [],
      startsAt: '2027-01-11T10:00:00-03:00', capacity: 2,
      clientIds: [clientIds[0]],
    })
    const gate = await pool.connect()
    await gate.query('BEGIN')
    await gate.query(
      'SELECT id FROM appointments WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [organizationId, appointment.id],
    )

    const attempts = clientIds.slice(1).map((clientId) => service.addAppointmentParticipant(
      'qa-session', organizationId, appointment.id, { clientId },
    ))
    let synchronizationError
    try {
      await waitForLockWaiters(pool, 2)
    } catch (error) {
      synchronizationError = error
    } finally {
      await gate.query('COMMIT')
      gate.release()
    }
    const settled = await Promise.allSettled(attempts)
    if (synchronizationError) throw synchronizationError

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409, code: 'CAPACITY_EXCEEDED' }),
      }),
    ])
    const occupancy = await pool.query(
      `SELECT count(*)::int AS count FROM appointment_participants
       WHERE organization_id = $1 AND appointment_id = $2
         AND status IN ('booked', 'confirmed', 'attended')`,
      [organizationId, appointment.id],
    )
    expect(occupancy.rows[0].count).toBe(2)
  }, 15_000)

  it('faz duas confirmações simultâneas convergirem para um único consumo da oferta', async () => {
    const occupantIds = [
      'aaaaaaaa-5000-4000-8000-000000000041',
      'aaaaaaaa-5000-4000-8000-000000000042',
    ]
    for (const [index, clientId] of occupantIds.entries()) {
      await pool.query(
        `INSERT INTO clients (id, organization_id, full_name, client_type)
         VALUES ($1, $2, $3, 'rotating')`,
        [clientId, organizationId, `Cliente Sintético WAIT-003 ${index + 1}`],
      )
    }
    const appointment = await service.createClassAppointment('qa-session', organizationId, {
      professionalId, unitId, serviceId, roomId: null, equipment: [],
      startsAt: '2027-03-15T10:00:00-03:00', capacity: 2, clientIds: occupantIds,
    })
    await repository.joinOwnWaitlist({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    })
    await repository.cancelAppointmentParticipant({
      actorUserId: ownerUserId, organizationId, appointmentId: appointment.id,
      clientId: occupantIds[0],
    })

    const gate = await pool.connect()
    await gate.query('BEGIN')
    await gate.query(
      'SELECT id FROM appointments WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [organizationId, appointment.id],
    )
    const attempts = [1, 2].map(() => repository.confirmOwnWaitlistOffer({
      actorUserId: clientUserId, organizationId, appointmentId: appointment.id,
    }))
    let synchronizationError
    try {
      await waitForLockWaiters(pool, 2)
    } catch (error) {
      synchronizationError = error
    } finally {
      await gate.query('COMMIT')
      gate.release()
    }
    const confirmations = await Promise.all(attempts)
    if (synchronizationError) throw synchronizationError

    expect(confirmations[0].participantId).toBe(confirmations[1].participantId)
    const state = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM appointment_participants
          WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
            AND status IN ('booked', 'confirmed', 'attended')) AS participants,
         (SELECT count(*)::int FROM waitlist_offers
          WHERE organization_id = $1 AND appointment_id = $2 AND status = 'consumed') AS offers,
         (SELECT count(*)::int FROM audit_events
          WHERE organization_id = $1 AND action = 'waitlist.offer_consumed'
            AND minimal_metadata->>'appointmentId' = $2::text) AS audits,
         (SELECT count(*)::int FROM outbox_events
          WHERE organization_id = $1 AND event_type = 'waitlist.offer.consumed'
            AND safe_payload->>'appointmentId' = $2::text) AS events`,
      [organizationId, appointment.id, fixedClientId],
    )
    expect(state.rows[0]).toEqual({ participants: 1, offers: 1, audits: 1, events: 1 })
  }, 15_000)

  it('preserva 09:00 local ao atravessar a mudança de horário de verão', async () => {
    const timezone = 'America/New_York'
    await pool.query(
      `INSERT INTO availability_rules
        (organization_id, professional_id, unit_id, rule_type, kind, weekday,
         local_start_time, local_end_time, timezone, label)
       VALUES ($1, $2, $3, 'available', 'working_hours', 7,
               '08:00', '12:00', $4, 'Expediente QA-002 DST')`,
      [organizationId, professionalId, unitId, timezone],
    )

    const series = await service.createAppointmentSeries('qa-session', organizationId, {
      clientId: fixedClientId, professionalId, unitId, serviceId, roomId: null, equipment: [],
      startsAt: '2026-10-25T09:00:00-04:00',
      recurrence: { frequency: 'weekly', interval: 1, count: 3, timezone },
    })
    const instants = series.appointments.map(({ startsAt }) => startsAt)

    expect(instants.map((instant) => instant.toISOString())).toEqual([
      '2026-10-25T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-08T14:00:00.000Z',
    ])
    expect(instants.map((instant) => localTimeParts(instant, timezone))).toEqual([
      { month: '10', day: '25', year: '2026', hour: '09', minute: '00' },
      { month: '11', day: '01', year: '2026', hour: '09', minute: '00' },
      { month: '11', day: '08', year: '2026', hour: '09', minute: '00' },
    ])
    expect(series.appointments.every(({ recurrence }) => recurrence.timezone === timezone)).toBe(true)
  })

  it('desfaz toda a série quando uma ocorrência intermediária conflita', async () => {
    await service.createAppointment('qa-session', organizationId, {
      clientId: 'aaaaaaaa-5000-4000-8000-000000000002',
      professionalId, unitId, serviceId, roomId: null, equipment: [],
      startsAt: '2027-02-11T09:00:00-03:00',
    })
    const before = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM recurrence_rules) AS recurrence_rules,
        (SELECT count(*)::int FROM appointments) AS appointments,
        (SELECT count(*)::int FROM appointment_participants) AS participants,
        (SELECT count(*)::int FROM audit_events) AS audit_events,
        (SELECT count(*)::int FROM outbox_events) AS outbox_events
    `)

    await expect(service.createAppointmentSeries('qa-session', organizationId, {
      clientId: fixedClientId, professionalId, unitId, serviceId, roomId: null, equipment: [],
      startsAt: '2027-02-04T09:00:00-03:00',
      recurrence: {
        frequency: 'weekly', interval: 1, count: 3, timezone: 'America/Sao_Paulo',
      },
    })).rejects.toMatchObject({ status: 409, code: expect.stringMatching(/CONFLICT$/u) })

    const after = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM recurrence_rules) AS recurrence_rules,
        (SELECT count(*)::int FROM appointments) AS appointments,
        (SELECT count(*)::int FROM appointment_participants) AS participants,
        (SELECT count(*)::int FROM audit_events) AS audit_events,
        (SELECT count(*)::int FROM outbox_events) AS outbox_events
    `)
    expect(after.rows[0]).toEqual(before.rows[0])
  })
  },
)
