import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { ServiceError } from './auth-service.mjs'
import { hashToken } from './security.mjs'

const { Pool } = pg

const roleDefinitions = [
  ['owner', 'Proprietário', true],
  ['admin', 'Administrador', true],
  ['professional', 'Profissional', false],
  ['reception_finance', 'Recepção/Financeiro', false],
  ['client', 'Cliente', false],
]
const resourceTables = Object.freeze({
  modalities: 'modalities', services: 'services', rooms: 'rooms', equipment: 'equipment',
})
const resourceTargetTypes = Object.freeze({
  modalities: 'modality', services: 'service', rooms: 'room', equipment: 'equipment',
})

async function inTransaction(pool, operation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function appendAuditEvent(client, {
  organizationId,
  actorUserId = null,
  actorMembershipId = null,
  action,
  targetType,
  targetId,
  minimalMetadata = {},
}) {
  let resolvedActorMembershipId = actorMembershipId
  if (!resolvedActorMembershipId && actorUserId) {
    const actor = await client.query(
      `SELECT id FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [organizationId, actorUserId],
    )
    if (!actor.rowCount) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    resolvedActorMembershipId = actor.rows[0].id
  }

  await client.query(
    `INSERT INTO audit_events
      (organization_id, actor_membership_id, action, target_type, target_id, minimal_metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      organizationId,
      resolvedActorMembershipId,
      action,
      targetType,
      targetId,
      JSON.stringify(minimalMetadata),
    ],
  )
}

async function appendUserAuditEvents(client, {
  userId,
  actorUserId = null,
  action,
  minimalMetadata = {},
}) {
  const memberships = await client.query(
    `SELECT membership.id, membership.organization_id
     FROM memberships membership
     JOIN organizations organization ON organization.id = membership.organization_id
     WHERE membership.user_id = $1 AND membership.status = 'active'
       AND organization.status = 'active'`,
    [userId],
  )
  for (const membership of memberships.rows) {
    await appendAuditEvent(client, {
      organizationId: membership.organization_id,
      actorMembershipId: actorUserId === userId ? membership.id : null,
      action,
      targetType: 'user',
      targetId: userId,
      minimalMetadata,
    })
  }
}

async function setTenantContext(client, actorUserId, organizationId) {
  await client.query("SELECT set_config('app.user_id', $1, true)", [actorUserId])
  await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId])
}

function mapClient(row, contacts = []) {
  const fixed = row.client_type === 'fixed'
  return {
    id: row.id,
    fullName: row.full_name,
    birthDate: row.birth_date,
    documentNumber: row.document_number,
    clientType: row.client_type,
    operationalRules: {
      planMode: fixed ? 'contract' : 'credits_or_single_booking',
      recurrenceMode: fixed ? 'reserved' : 'availability_only',
    },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      type: contact.type,
      value: contact.value,
      preferred: contact.preferred,
    })),
  }
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return typeof value === 'string' ? value.slice(0, 10) : value
}

const effectiveReceivableStatusSql = `CASE
  WHEN receivable.status = 'cancelled' THEN 'cancelled'
  WHEN balance.balance_cents <= 0 THEN 'paid'
  WHEN balance.paid_amount_cents > 0 THEN 'partially_paid'
  WHEN receivable.due_on < CURRENT_DATE THEN 'overdue'
  ELSE 'open'
END`

const receivableSelect = `SELECT receivable.id, receivable.client_id, client_record.full_name AS client_name,
  receivable.category_id, category.name AS category_name, receivable.contract_id,
  receivable.description, receivable.original_amount_cents, receivable.currency,
  receivable.competence_on, receivable.due_on, ${effectiveReceivableStatusSql} AS effective_status,
  balance.paid_amount_cents, balance.balance_cents, receivable.recurrence_id,
  receivable.installment_number, recurrence.installment_count,
  receivable.cancelled_at, receivable.cancellation_reason,
  receivable.created_at, receivable.updated_at
 FROM receivables receivable
 JOIN clients client_record
   ON client_record.organization_id = receivable.organization_id AND client_record.id = receivable.client_id
 JOIN financial_categories category
   ON category.organization_id = receivable.organization_id AND category.id = receivable.category_id
 JOIN receivable_balances balance
   ON balance.organization_id = receivable.organization_id AND balance.receivable_id = receivable.id
 LEFT JOIN receivable_recurrences recurrence
   ON recurrence.organization_id = receivable.organization_id AND recurrence.id = receivable.recurrence_id`

function mapDateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value
}

function mapReceivable(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    contractId: row.contract_id,
    description: row.description,
    originalAmountCents: Number(row.original_amount_cents),
    paidAmountCents: Number(row.paid_amount_cents),
    balanceCents: Number(row.balance_cents),
    currency: row.currency,
    competenceOn: mapDateOnly(row.competence_on),
    dueOn: mapDateOnly(row.due_on),
    status: row.effective_status,
    recurrenceId: row.recurrence_id,
    installmentNumber: row.installment_number,
    installmentCount: row.installment_count,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function selectReceivable(client, organizationId, receivableId) {
  const result = await client.query(
    `${receivableSelect} WHERE receivable.organization_id = $1 AND receivable.id = $2`,
    [organizationId, receivableId],
  )
  return result.rowCount ? mapReceivable(result.rows[0]) : null
}

function mapFinancialPayment(row) {
  return {
    id: row.id,
    amountCents: Number(row.amount_cents),
    method: row.method,
    externalReference: row.external_reference,
    paidAt: row.paid_at,
    reversesPaymentId: row.reverses_payment_id,
    reversalReason: row.reversal_reason,
    reversed: Boolean(row.reversal_id),
    createdAt: row.created_at,
  }
}

async function selectReceivablePayment(client, organizationId, paymentId) {
  const result = await client.query(
    `SELECT payment.*, reversal.id AS reversal_id
     FROM payments payment
     LEFT JOIN payments reversal
       ON reversal.organization_id = payment.organization_id
      AND reversal.reverses_payment_id = payment.id
     WHERE payment.organization_id = $1 AND payment.id = $2`,
    [organizationId, paymentId],
  )
  return result.rowCount ? mapFinancialPayment(result.rows[0]) : null
}

const effectivePayableStatusSql = `CASE
  WHEN payable.status = 'cancelled' THEN 'cancelled'
  WHEN balance.balance_cents <= 0 THEN 'paid'
  WHEN balance.paid_amount_cents > 0 THEN 'partially_paid'
  WHEN payable.due_on < CURRENT_DATE THEN 'overdue'
  ELSE 'open'
END`

const payableSelect = `SELECT payable.id, payable.category_id, category.name AS category_name,
  payable.counterparty, payable.description, payable.amount_cents AS original_amount_cents,
  payable.currency, payable.competence_on, payable.due_on,
  ${effectivePayableStatusSql} AS effective_status,
  balance.paid_amount_cents, balance.balance_cents, payable.recurrence_id,
  payable.installment_number, recurrence.installment_count,
  payable.cancelled_at, payable.cancellation_reason, payable.created_at, payable.updated_at
 FROM payables payable
 JOIN financial_categories category
   ON category.organization_id = payable.organization_id AND category.id = payable.category_id
 JOIN payable_balances balance
   ON balance.organization_id = payable.organization_id AND balance.payable_id = payable.id
 LEFT JOIN payable_recurrences recurrence
   ON recurrence.organization_id = payable.organization_id AND recurrence.id = payable.recurrence_id`

function mapPayable(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    counterparty: row.counterparty,
    description: row.description,
    originalAmountCents: Number(row.original_amount_cents),
    paidAmountCents: Number(row.paid_amount_cents),
    balanceCents: Number(row.balance_cents),
    currency: row.currency,
    competenceOn: mapDateOnly(row.competence_on),
    dueOn: mapDateOnly(row.due_on),
    status: row.effective_status,
    recurrenceId: row.recurrence_id,
    installmentNumber: row.installment_number,
    installmentCount: row.installment_count,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function selectPayable(client, organizationId, payableId) {
  const result = await client.query(
    `${payableSelect} WHERE payable.organization_id = $1 AND payable.id = $2`,
    [organizationId, payableId],
  )
  return result.rowCount ? mapPayable(result.rows[0]) : null
}

async function selectPayablePayment(client, organizationId, paymentId) {
  const result = await client.query(
    `SELECT payment.*, reversal.id AS reversal_id
     FROM payable_payments payment
     LEFT JOIN payable_payments reversal
       ON reversal.organization_id = payment.organization_id
      AND reversal.reverses_payment_id = payment.id
     WHERE payment.organization_id = $1 AND payment.id = $2`,
    [organizationId, paymentId],
  )
  return result.rowCount ? mapFinancialPayment(result.rows[0]) : null
}

const accentedLetters = 'áàâãäéèêëíìîïóòôõöúùûüçñ'
const plainLetters = 'aaaaaeeeeiiiiooooouuuucn'

function containsPattern(value) {
  if (!value) return null
  const folded = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  return `%${folded.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function foldedText(expression) {
  return `translate(lower(${expression}), '${accentedLetters}', '${plainLetters}')`
}

function addMonthsClamped(dateText, months) {
  const [year, month, day] = dateText.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay),
  )).toISOString().slice(0, 10)
}

async function insertClientContacts(client, organizationId, clientId, contacts) {
  for (const contact of contacts) {
    await client.query(
      `INSERT INTO client_contacts
        (organization_id, client_id, type, value, normalized_value, preferred)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, clientId, contact.type, contact.value, contact.normalizedValue, contact.preferred],
    )
  }
}

async function selectClient(client, organizationId, clientId) {
  const result = await client.query(
    `SELECT id, full_name, birth_date, document_number, client_type, status, created_at, updated_at
     FROM clients
     WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [organizationId, clientId],
  )
  if (!result.rowCount) return null
  const contacts = await client.query(
    `SELECT id, type, value, preferred FROM client_contacts
     WHERE organization_id = $1 AND client_id = $2
     ORDER BY preferred DESC, type, value`,
    [organizationId, clientId],
  )
  return mapClient(result.rows[0], contacts.rows)
}

function mapProspect(row, contacts = [], interactions = []) {
  return {
    id: row.id,
    fullName: row.full_name,
    stage: row.stage,
    source: row.source,
    owner: row.owner_professional_id ? {
      id: row.owner_professional_id,
      displayName: row.owner_display_name,
    } : null,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      type: contact.type,
      value: contact.value,
      preferred: contact.preferred,
    })),
    nextActionAt: row.next_action_at,
    nextActionNote: row.next_action_note,
    convertedClientId: row.converted_client_id,
    convertedAt: row.converted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    interactions: interactions.map((interaction) => ({
      id: interaction.id,
      type: interaction.type,
      notes: interaction.notes,
      occurredAt: interaction.occurred_at,
    })),
  }
}

async function insertProspectContacts(client, organizationId, prospectId, contacts) {
  for (const contact of contacts) {
    await client.query(
      `INSERT INTO prospect_contacts
        (organization_id, prospect_id, type, value, normalized_value, preferred)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, prospectId, contact.type, contact.value, contact.normalizedValue, contact.preferred],
    )
  }
}

function mapResourceRow(kind, row) {
  const common = {
    id: row.id,
    name: row.name,
    active: row.active,
    associationsCount: row.associations_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (kind === 'services') return {
    ...common,
    modalityId: row.modality_id,
    modalityName: row.modality_name,
    durationMinutes: row.duration_minutes,
    defaultCapacity: row.default_capacity,
  }
  if (kind === 'rooms') return {
    ...common,
    unitId: row.unit_id,
    unitName: row.unit_name,
    capacity: row.capacity,
  }
  if (kind === 'equipment') return {
    ...common,
    unitId: row.unit_id,
    unitName: row.unit_name,
    quantity: row.quantity,
  }
  return common
}

async function selectResource(client, organizationId, kind, resourceId) {
  let query
  if (kind === 'modalities') query = `
    SELECT resource.*,
      (SELECT count(*)::int FROM services linked
       WHERE linked.organization_id = resource.organization_id
         AND linked.modality_id = resource.id) AS associations_count
    FROM modalities resource
    WHERE resource.organization_id = $1 AND resource.id = $2`
  if (kind === 'services') query = `
    SELECT resource.*, modality.name AS modality_name,
      (SELECT count(*)::int FROM appointments linked
       WHERE linked.organization_id = resource.organization_id
         AND linked.service_id = resource.id) AS associations_count
    FROM services resource
    JOIN modalities modality
      ON modality.organization_id = resource.organization_id AND modality.id = resource.modality_id
    WHERE resource.organization_id = $1 AND resource.id = $2`
  if (kind === 'rooms') query = `
    SELECT resource.*, unit.name AS unit_name,
      (SELECT count(*)::int FROM appointments linked
       WHERE linked.organization_id = resource.organization_id
         AND linked.room_id = resource.id) AS associations_count
    FROM rooms resource
    JOIN units unit ON unit.organization_id = resource.organization_id AND unit.id = resource.unit_id
    WHERE resource.organization_id = $1 AND resource.id = $2`
  if (kind === 'equipment') query = `
    SELECT resource.*, unit.name AS unit_name,
      (SELECT count(DISTINCT linked.appointment_id)::int FROM appointment_equipment linked
       WHERE linked.organization_id = resource.organization_id
         AND linked.equipment_id = resource.id) AS associations_count
    FROM equipment resource
    JOIN units unit ON unit.organization_id = resource.organization_id AND unit.id = resource.unit_id
    WHERE resource.organization_id = $1 AND resource.id = $2`
  const result = await client.query(query, [organizationId, resourceId])
  return result.rowCount ? mapResourceRow(kind, result.rows[0]) : null
}

function mapAvailability(row) {
  return {
    id: row.id,
    professionalId: row.professional_id,
    professionalName: row.professional_name,
    unitId: row.unit_id,
    unitName: row.unit_name,
    kind: row.kind,
    weekday: row.weekday,
    localStartTime: row.local_start_time,
    localEndTime: row.local_end_time,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    label: row.label,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAppointment(row) {
  const participants = Array.isArray(row.participants) ? row.participants.map((participant) => ({
    id: participant.id,
    client: { id: participant.clientId, fullName: participant.clientName },
    status: participant.status,
    statusReason: participant.statusReason ?? null,
    bookedAt: participant.bookedAt,
    history: Array.isArray(participant.history) ? participant.history : [],
  })) : []
  return {
    id: row.id,
    unit: { id: row.unit_id, name: row.unit_name, timezone: row.unit_timezone },
    service: {
      id: row.service_id, name: row.service_name, durationMinutes: row.duration_minutes,
    },
    professional: {
      id: row.professional_id,
      displayName: row.professional_name,
      registrationNumber: row.professional_registration_number ?? null,
    },
    room: row.room_id ? { id: row.room_id, name: row.room_name } : null,
    equipment: Array.isArray(row.equipment) ? row.equipment : [],
    client: row.client_id ? { id: row.client_id, fullName: row.client_name } : null,
    participants,
    waitlist: Array.isArray(row.waitlist) ? row.waitlist.map((entry) => ({
      id: entry.id,
      client: { id: entry.clientId, fullName: entry.clientName },
      status: entry.status,
      position: entry.position,
      queuedAt: entry.queuedAt,
      offer: entry.offerId ? {
        id: entry.offerId, status: entry.offerStatus,
        offeredAt: entry.offeredAt, expiresAt: entry.expiresAt,
      } : null,
    })) : [],
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    participantStatus: row.participant_status,
    capacity: row.capacity,
    occupancy: row.occupancy ?? 0,
    appointmentType: row.appointment_type ?? 'individual',
    recurrence: row.recurrence_rule_id ? {
      id: row.recurrence_rule_id,
      occurrenceIndex: row.occurrence_index,
      frequency: row.recurrence_frequency,
      interval: row.recurrence_interval,
      count: row.recurrence_count,
      timezone: row.recurrence_timezone,
    } : null,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const appointmentSelect = `
  SELECT appointment.*, unit.name AS unit_name, unit.timezone AS unit_timezone,
         service.name AS service_name, service.duration_minutes,
         professional.display_name AS professional_name,
         professional.registration_number AS professional_registration_number,
         room.name AS room_name,
         participant.client_id, participant.status AS participant_status,
         client.full_name AS client_name,
         recurrence.frequency AS recurrence_frequency,
         recurrence.interval_count AS recurrence_interval,
         recurrence.occurrence_count AS recurrence_count,
         recurrence.timezone AS recurrence_timezone,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', listed.id, 'clientId', listed.client_id,
             'clientName', listed_client.full_name, 'status', listed.status,
             'statusReason', listed.cancellation_reason, 'bookedAt', listed.booked_at,
             'history', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', history.id, 'fromStatus', history.from_status,
                 'toStatus', history.to_status, 'reason', history.reason,
                 'actorMembershipId', history.actor_membership_id,
                 'occurredAt', history.occurred_at
               ) ORDER BY history.occurred_at, history.id)
               FROM appointment_participant_status_history history
               WHERE history.organization_id = listed.organization_id
                 AND history.participant_id = listed.id
             ), '[]'::jsonb)
           ) ORDER BY listed.booked_at, listed.id)
           FROM appointment_participants listed
           JOIN clients listed_client
             ON listed_client.organization_id = listed.organization_id
            AND listed_client.id = listed.client_id
           WHERE listed.organization_id = appointment.organization_id
             AND listed.appointment_id = appointment.id
         ), '[]'::jsonb) AS participants,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', entry.id, 'clientId', entry.client_id,
             'clientName', waiting_client.full_name, 'status', entry.status,
             'position', entry.queue_position, 'queuedAt', entry.queued_at,
             'offerId', offer.id, 'offerStatus', offer.status,
             'offeredAt', offer.offered_at, 'expiresAt', offer.expires_at
           ) ORDER BY entry.queue_position)
           FROM waitlist_entries entry
           JOIN clients waiting_client
             ON waiting_client.organization_id = entry.organization_id
            AND waiting_client.id = entry.client_id
           LEFT JOIN LATERAL (
             SELECT current_offer.id, current_offer.status,
                    current_offer.offered_at, current_offer.expires_at
             FROM waitlist_offers current_offer
             WHERE current_offer.organization_id = entry.organization_id
               AND current_offer.waitlist_entry_id = entry.id
             ORDER BY current_offer.offered_at DESC, current_offer.id DESC
             LIMIT 1
           ) offer ON true
           WHERE entry.organization_id = appointment.organization_id
             AND entry.appointment_id = appointment.id
             AND entry.status IN ('queued', 'offered')
         ), '[]'::jsonb) AS waitlist,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', linked.equipment_id, 'name', equipment.name,
             'quantity', linked.quantity
           ) ORDER BY equipment.name, equipment.id)
           FROM appointment_equipment linked
           JOIN equipment ON equipment.organization_id = linked.organization_id
                         AND equipment.id = linked.equipment_id
           WHERE linked.organization_id = appointment.organization_id
             AND linked.appointment_id = appointment.id
         ), '[]'::jsonb) AS equipment,
         (SELECT count(*)::int FROM appointment_participants occupied
          WHERE occupied.organization_id = appointment.organization_id
            AND occupied.appointment_id = appointment.id
            AND occupied.status IN ('booked', 'confirmed', 'attended')) AS occupancy
  FROM appointments appointment
  JOIN units unit ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
  JOIN services service ON service.organization_id = appointment.organization_id AND service.id = appointment.service_id
  JOIN professionals professional
    ON professional.organization_id = appointment.organization_id AND professional.id = appointment.professional_id
  LEFT JOIN rooms room ON room.organization_id = appointment.organization_id AND room.id = appointment.room_id
  LEFT JOIN recurrence_rules recurrence
    ON recurrence.organization_id = appointment.organization_id
   AND recurrence.id = appointment.recurrence_rule_id
  LEFT JOIN LATERAL (
    SELECT listed.client_id, listed.status FROM appointment_participants listed
    WHERE listed.organization_id = appointment.organization_id AND listed.appointment_id = appointment.id
    ORDER BY listed.booked_at, listed.id LIMIT 1
  ) participant ON true
  LEFT JOIN clients client
    ON client.organization_id = appointment.organization_id AND client.id = participant.client_id`

async function selectAppointment(client, organizationId, appointmentId) {
  const result = await client.query(
    `${appointmentSelect} WHERE appointment.organization_id = $1 AND appointment.id = $2`,
    [organizationId, appointmentId],
  )
  return result.rowCount ? mapAppointment(result.rows[0]) : null
}

function mapOwnAppointment(row) {
  return {
    id: row.id,
    participantId: row.participant_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    participantStatus: row.participant_status,
    service: { id: row.service_id, name: row.service_name },
    professional: {
      id: row.professional_id,
      displayName: row.professional_name,
      registrationNumber: row.professional_registration_number ?? null,
    },
    unit: { id: row.unit_id, name: row.unit_name, timezone: row.unit_timezone },
    room: row.room_id ? { id: row.room_id, name: row.room_name } : null,
    checkedInAt: row.checked_in_at,
    checkIn: {
      allowed: row.checkin_allowed,
      reason: row.checkin_reason,
      opensAt: row.checkin_opens_at,
      closesAt: row.checkin_closes_at,
    },
    replacementCreditId: row.replacement_credit_id ?? null,
  }
}

function mapReplacementCredit(row) {
  return {
    id: row.id,
    status: row.effective_status ?? row.status,
    expiresOn: row.expires_on,
    createdAt: row.created_at,
    source: {
      participantId: row.source_participant_id,
      appointmentId: row.source_appointment_id,
      startsAt: row.source_starts_at,
      status: row.source_status,
    },
    consumption: row.consumed_by_participant_id ? {
      participantId: row.consumed_by_participant_id,
      appointmentId: row.destination_appointment_id,
      consumedAt: row.consumed_at,
    } : null,
  }
}

const replacementCreditSelect = `
  SELECT credit.id, credit.status,
         CASE WHEN credit.status = 'available'
                AND credit.expires_on < (clock_timestamp() AT TIME ZONE source_unit.timezone)::date
              THEN 'expired' ELSE credit.status END AS effective_status,
         credit.expires_on, credit.created_at,
         credit.source_participant_id,
         source.appointment_id AS source_appointment_id,
         source.status AS source_status,
         source_appointment.starts_at AS source_starts_at,
         credit.consumed_by_participant_id, credit.consumed_at,
         destination.appointment_id AS destination_appointment_id
  FROM replacement_credits credit
  JOIN appointment_participants source
    ON source.organization_id = credit.organization_id
   AND source.id = credit.source_participant_id
  JOIN appointments source_appointment
    ON source_appointment.organization_id = source.organization_id
   AND source_appointment.id = source.appointment_id
  JOIN units source_unit
    ON source_unit.organization_id = source_appointment.organization_id
   AND source_unit.id = source_appointment.unit_id
  LEFT JOIN appointment_participants destination
    ON destination.organization_id = credit.organization_id
   AND destination.id = credit.consumed_by_participant_id`

async function selectReplacementCredit(client, organizationId, creditId) {
  const result = await client.query(
    `${replacementCreditSelect}
     WHERE credit.organization_id = $1 AND credit.id = $2`,
    [organizationId, creditId],
  )
  return result.rowCount ? mapReplacementCredit(result.rows[0]) : null
}

function mapWaitlistEntry(row) {
  return {
    id: row.id,
    appointment: {
      id: row.appointment_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      service: { id: row.service_id, name: row.service_name },
      professional: { id: row.professional_id, displayName: row.professional_name },
      unit: { id: row.unit_id, name: row.unit_name, timezone: row.unit_timezone },
      room: row.room_id ? { id: row.room_id, name: row.room_name } : null,
    },
    status: row.status,
    position: row.position,
    queuedAt: row.queued_at,
    offer: row.offer_id ? {
      id: row.offer_id,
      status: row.offer_status,
      offeredAt: row.offered_at,
      expiresAt: row.expires_at,
    } : null,
  }
}

const waitlistEntrySelect = `
  SELECT entry.id, entry.appointment_id, entry.status, entry.queued_at,
         (SELECT count(*)::int
          FROM waitlist_entries ahead
          WHERE ahead.organization_id = entry.organization_id
            AND ahead.appointment_id = entry.appointment_id
            AND ahead.status IN ('queued', 'offered')
            AND ahead.queue_position <= entry.queue_position) AS position,
         appointment.starts_at, appointment.ends_at,
         service.id AS service_id, service.name AS service_name,
         professional.id AS professional_id, professional.display_name AS professional_name,
         professional.registration_number AS professional_registration_number,
         unit.id AS unit_id, unit.name AS unit_name, unit.timezone AS unit_timezone,
         room.id AS room_id, room.name AS room_name,
         offer.id AS offer_id, offer.status AS offer_status,
         offer.offered_at, offer.expires_at
  FROM waitlist_entries entry
  JOIN appointments appointment
    ON appointment.organization_id = entry.organization_id
   AND appointment.id = entry.appointment_id
  JOIN services service
    ON service.organization_id = appointment.organization_id AND service.id = appointment.service_id
  JOIN professionals professional
    ON professional.organization_id = appointment.organization_id
   AND professional.id = appointment.professional_id
  JOIN units unit
    ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
  LEFT JOIN rooms room
    ON room.organization_id = appointment.organization_id AND room.id = appointment.room_id
  LEFT JOIN LATERAL (
    SELECT listed.id, listed.status, listed.offered_at, listed.expires_at
    FROM waitlist_offers listed
    WHERE listed.organization_id = entry.organization_id
      AND listed.waitlist_entry_id = entry.id
    ORDER BY listed.offered_at DESC, listed.id DESC LIMIT 1
  ) offer ON true`

async function selectWaitlistEntry(client, organizationId, entryId) {
  const result = await client.query(
    `${waitlistEntrySelect}
     WHERE entry.organization_id = $1 AND entry.id = $2`,
    [organizationId, entryId],
  )
  return result.rowCount ? mapWaitlistEntry(result.rows[0]) : null
}

async function appendWaitlistOutbox(client, {
  organizationId, aggregateType, aggregateId, eventType, safePayload = {}, idempotencyKey,
}) {
  await client.query(
    `INSERT INTO outbox_events
      (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [organizationId, aggregateType, aggregateId, eventType,
      JSON.stringify(safePayload), idempotencyKey],
  )
}

async function advanceWaitlistOffer(client, organizationId, appointmentId) {
  const appointment = await client.query(
    `SELECT appointment.id, appointment.appointment_type, appointment.status,
            appointment.starts_at > clock_timestamp() AS is_future,
            appointment.capacity,
            organization.waitlist_offer_minutes
     FROM appointments appointment
     JOIN organizations organization ON organization.id = appointment.organization_id
     WHERE appointment.organization_id = $1 AND appointment.id = $2
     FOR UPDATE OF appointment`,
    [organizationId, appointmentId],
  )
  if (!appointment.rowCount) return null

  const expired = await client.query(
    `UPDATE waitlist_offers
     SET status = 'expired'
     WHERE organization_id = $1 AND appointment_id = $2
       AND status = 'active' AND expires_at <= clock_timestamp()
     RETURNING id, waitlist_entry_id`,
    [organizationId, appointmentId],
  )
  for (const offer of expired.rows) {
    await client.query(
      `UPDATE waitlist_entries SET status = 'expired'
       WHERE organization_id = $1 AND id = $2 AND status = 'offered'`,
      [organizationId, offer.waitlist_entry_id],
    )
    await appendAuditEvent(client, {
      organizationId, action: 'waitlist.offer_expired', targetType: 'waitlist_offer',
      targetId: offer.id, minimalMetadata: { appointmentId, waitlistEntryId: offer.waitlist_entry_id },
    })
    await appendWaitlistOutbox(client, {
      organizationId, aggregateType: 'waitlist_offer', aggregateId: offer.id,
      eventType: 'waitlist.offer.expired', safePayload: { appointmentId },
      idempotencyKey: `waitlist.offer.expired:${offer.id}`,
    })
  }

  const current = appointment.rows[0]
  if (current.appointment_type !== 'class' || current.status !== 'scheduled'
    || !current.is_future) {
    await client.query(
      `UPDATE waitlist_offers SET status = 'cancelled'
       WHERE organization_id = $1 AND appointment_id = $2 AND status = 'active'`,
      [organizationId, appointmentId],
    )
    await client.query(
      `UPDATE waitlist_entries SET status = 'cancelled'
       WHERE organization_id = $1 AND appointment_id = $2
         AND status IN ('queued', 'offered')`,
      [organizationId, appointmentId],
    )
    return null
  }

  const occupancy = await client.query(
    `SELECT count(*)::int AS count FROM appointment_participants
     WHERE organization_id = $1 AND appointment_id = $2
       AND status IN ('booked', 'confirmed', 'attended')`,
    [organizationId, appointmentId],
  )
  if (occupancy.rows[0].count >= current.capacity) return null

  const active = await client.query(
    `SELECT id, waitlist_entry_id, offered_at, expires_at
     FROM waitlist_offers
     WHERE organization_id = $1 AND appointment_id = $2 AND status = 'active'`,
    [organizationId, appointmentId],
  )
  if (active.rowCount) return active.rows[0]

  const next = await client.query(
    `SELECT id FROM waitlist_entries
     WHERE organization_id = $1 AND appointment_id = $2 AND status = 'queued'
     ORDER BY queue_position
     LIMIT 1 FOR UPDATE`,
    [organizationId, appointmentId],
  )
  if (!next.rowCount) return null
  const entryId = next.rows[0].id
  await client.query(
    `UPDATE waitlist_entries SET status = 'offered'
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, entryId],
  )
  const offer = await client.query(
    `INSERT INTO waitlist_offers
      (organization_id, appointment_id, waitlist_entry_id, expires_at)
     VALUES ($1, $2, $3,
       clock_timestamp() + $4::integer * interval '1 minute')
     RETURNING id, waitlist_entry_id, offered_at, expires_at`,
    [organizationId, appointmentId, entryId, current.waitlist_offer_minutes],
  )
  const created = offer.rows[0]
  await appendAuditEvent(client, {
    organizationId, action: 'waitlist.offer_created', targetType: 'waitlist_offer',
    targetId: created.id, minimalMetadata: { appointmentId, waitlistEntryId: entryId },
  })
  await appendWaitlistOutbox(client, {
    organizationId, aggregateType: 'waitlist_offer', aggregateId: created.id,
    eventType: 'waitlist.offer.created',
    safePayload: { appointmentId, offerId: created.id, expiresAt: created.expires_at },
    idempotencyKey: `waitlist.offer.created:${created.id}`,
  })
  return created
}

const ownAppointmentSelect = `
  SELECT appointment.id, participant.id AS participant_id,
         appointment.starts_at, appointment.ends_at, appointment.status,
         participant.status AS participant_status,
         service.id AS service_id, service.name AS service_name,
         professional.id AS professional_id, professional.display_name AS professional_name,
         professional.registration_number AS professional_registration_number,
         unit.id AS unit_id, unit.name AS unit_name, unit.timezone AS unit_timezone,
         room.id AS room_id, room.name AS room_name, checkin.checked_in_at,
         appointment.starts_at - organization.self_checkin_before_minutes * interval '1 minute'
           AS checkin_opens_at,
         appointment.starts_at + organization.self_checkin_after_minutes * interval '1 minute'
           AS checkin_closes_at,
         (organization.self_checkin_enabled
           AND appointment.status = 'scheduled'
           AND participant.status IN ('booked', 'confirmed')
           AND checkin.id IS NULL
           AND now() BETWEEN
             appointment.starts_at - organization.self_checkin_before_minutes * interval '1 minute'
             AND appointment.starts_at + organization.self_checkin_after_minutes * interval '1 minute'
         ) AS checkin_allowed,
         CASE
           WHEN checkin.id IS NOT NULL THEN 'already_checked_in'
           WHEN NOT organization.self_checkin_enabled THEN 'disabled'
           WHEN appointment.status <> 'scheduled'
             OR participant.status NOT IN ('booked', 'confirmed') THEN 'unavailable'
           WHEN now() < appointment.starts_at
             - organization.self_checkin_before_minutes * interval '1 minute' THEN 'too_early'
           WHEN now() > appointment.starts_at
             + organization.self_checkin_after_minutes * interval '1 minute' THEN 'window_closed'
           ELSE NULL
         END AS checkin_reason,
         replacement_credit.id AS replacement_credit_id
  FROM appointment_participants participant
  JOIN appointments appointment
    ON appointment.organization_id = participant.organization_id
   AND appointment.id = participant.appointment_id
  JOIN organizations organization ON organization.id = appointment.organization_id
  JOIN services service
    ON service.organization_id = appointment.organization_id AND service.id = appointment.service_id
  JOIN professionals professional
    ON professional.organization_id = appointment.organization_id
   AND professional.id = appointment.professional_id
  JOIN units unit
    ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
  LEFT JOIN rooms room
    ON room.organization_id = appointment.organization_id AND room.id = appointment.room_id
  LEFT JOIN checkins checkin
    ON checkin.organization_id = participant.organization_id
   AND checkin.appointment_participant_id = participant.id
  LEFT JOIN replacement_credits replacement_credit
    ON replacement_credit.organization_id = participant.organization_id
   AND replacement_credit.consumed_by_participant_id = participant.id`

async function consumeReplacementCredit(client, {
  organizationId, clientId, participantId, appointmentDate,
}) {
  const result = await client.query(
    `WITH selected AS (
       SELECT credit.id
       FROM replacement_credits credit
       JOIN appointment_participants source
         ON source.organization_id = credit.organization_id
        AND source.id = credit.source_participant_id
       JOIN appointments source_appointment
         ON source_appointment.organization_id = source.organization_id
        AND source_appointment.id = source.appointment_id
       JOIN units source_unit
         ON source_unit.organization_id = source_appointment.organization_id
        AND source_unit.id = source_appointment.unit_id
       WHERE credit.organization_id = $1 AND credit.client_id = $2
         AND credit.status = 'available' AND credit.expires_on >= $3::date
         AND (source_appointment.starts_at AT TIME ZONE source_unit.timezone)::date <= $3::date
       ORDER BY credit.expires_on, credit.created_at, credit.id
       LIMIT 1 FOR UPDATE OF credit SKIP LOCKED
     )
     UPDATE replacement_credits available
     SET status = 'consumed', consumed_at = clock_timestamp(),
         consumed_by_participant_id = $4
     FROM selected
     WHERE available.organization_id = $1 AND available.id = selected.id
       AND available.status = 'available'
     RETURNING available.id`,
    [organizationId, clientId, appointmentDate, participantId],
  )
  return result.rows[0]?.id ?? null
}

async function recordReplacementCreditConsumption(client, {
  organizationId, actorMembershipId, creditId, participantId, appointmentId,
}) {
  await appendAuditEvent(client, {
    organizationId, actorMembershipId,
    action: 'replacement_credit.consumed', targetType: 'replacement_credit', targetId: creditId,
    minimalMetadata: { participantId, appointmentId },
  })
  await client.query(
    `INSERT INTO outbox_events
      (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
     VALUES ($1, 'replacement_credit', $2, 'replacement_credit.consumed',
             jsonb_build_object('appointmentId', $3::text), $4)`,
    [organizationId, creditId, appointmentId, `replacement_credit.consumed:${creditId}`],
  )
}

async function replaceAppointmentEquipment(client, organizationId, appointmentIds, equipment = []) {
  if (!appointmentIds.length) return
  await client.query(
    `DELETE FROM appointment_equipment
     WHERE organization_id = $1 AND appointment_id = ANY($2::uuid[])`,
    [organizationId, appointmentIds],
  )
  const sorted = [...equipment].sort((left, right) => left.equipmentId.localeCompare(right.equipmentId))
  for (const appointmentId of appointmentIds) {
    for (const allocation of sorted) {
      await client.query(
        `INSERT INTO appointment_equipment
          (organization_id, appointment_id, equipment_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, appointmentId, allocation.equipmentId, allocation.quantity],
      )
    }
  }
}

async function ensureAvailabilityKeepsAppointmentsValid(client, organizationId, professionalId, unitId) {
  const invalid = await client.query(
    `SELECT id FROM appointments
     WHERE organization_id = $1 AND professional_id = $2 AND unit_id = $3
       AND status = 'scheduled'
       AND NOT appointment_matches_availability(
         organization_id, professional_id, unit_id, starts_at, ends_at
       )
     LIMIT 1`,
    [organizationId, professionalId, unitId],
  )
  if (invalid.rowCount) {
    throw new ServiceError(
      409, 'AVAILABILITY_CONFLICT',
      'A regra deixaria um agendamento existente fora da disponibilidade.',
    )
  }
}

async function requireActiveProspectOwner(client, organizationId, ownerProfessionalId) {
  if (ownerProfessionalId === null) return
  const owner = await client.query(
    `SELECT id FROM professionals
     WHERE organization_id = $1 AND id = $2 AND active AND deleted_at IS NULL`,
    [organizationId, ownerProfessionalId],
  )
  if (!owner.rowCount) {
    throw new ServiceError(400, 'INVALID_PROSPECT_OWNER', 'O responsável não pertence a esta organização.')
  }
}

async function selectProspect(client, organizationId, prospectId, includeInteractions = true) {
  const result = await client.query(
    `SELECT prospect.id, prospect.full_name, prospect.stage, prospect.source,
            prospect.owner_professional_id, owner.display_name AS owner_display_name,
            prospect.next_action_at, prospect.next_action_note, prospect.converted_client_id,
            prospect.converted_at, prospect.created_at, prospect.updated_at
     FROM prospects prospect
     LEFT JOIN professionals owner
       ON owner.organization_id = prospect.organization_id
      AND owner.id = prospect.owner_professional_id
     WHERE prospect.organization_id = $1 AND prospect.id = $2`,
    [organizationId, prospectId],
  )
  if (!result.rowCount) return null
  const contacts = await client.query(
    `SELECT id, type, value, preferred FROM prospect_contacts
     WHERE organization_id = $1 AND prospect_id = $2
     ORDER BY preferred DESC, type, value`,
    [organizationId, prospectId],
  )
  let interactions = { rows: [] }
  if (includeInteractions) {
    interactions = await client.query(
      `SELECT id, type, notes, occurred_at FROM prospect_interactions
       WHERE organization_id = $1 AND prospect_id = $2
       ORDER BY occurred_at DESC, id DESC LIMIT 50`,
      [organizationId, prospectId],
    )
  }
  return mapProspect(result.rows[0], contacts.rows, interactions.rows)
}

async function insertOrganization(client, userId, name, origin) {
  const organization = await client.query(
    `INSERT INTO organizations (legal_name, trade_name)
     VALUES ($1, $1) RETURNING id`,
    [name],
  )
  const organizationId = organization.rows[0].id

  for (const [code, roleName, privileged] of roleDefinitions) {
    await client.query(
      `INSERT INTO roles (organization_id, code, name, privileged)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, code, roleName, privileged],
    )
  }
  await client.query(
    `INSERT INTO role_permissions (organization_id, role_id, permission_id)
     SELECT $1, role.id, defaults.permission_id
     FROM roles role
     JOIN role_permission_defaults defaults ON defaults.role_code = role.code
     WHERE role.organization_id = $1`,
    [organizationId],
  )
  const ownerRole = await client.query(
    `SELECT id FROM roles WHERE organization_id = $1 AND code = 'owner'`,
    [organizationId],
  )
  const ownerMembership = await client.query(
    `INSERT INTO memberships (organization_id, user_id, role_id, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [organizationId, userId, ownerRole.rows[0].id],
  )
  await client.query(
    `INSERT INTO financial_categories (organization_id, kind, name)
     VALUES ($1, 'receivable', 'Geral')`,
    [organizationId],
  )
  await appendAuditEvent(client, {
    organizationId,
    actorMembershipId: ownerMembership.rows[0].id,
    action: 'organization.created',
    targetType: 'organization',
    targetId: organizationId,
    minimalMetadata: { origin },
  })
  return organizationId
}

export class PostgresAuthRepository {
  constructor(connectionString, options = {}) {
    this.pool = options.pool ?? new Pool({ connectionString, max: 10 })
  }

  close() {
    return this.pool.end()
  }

  registerAccount({ email, passwordHash, organizationName }) {
    return inTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT u.id, u.status, c.user_id IS NOT NULL AS has_credential
         FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE u.email_normalized = $1 FOR UPDATE OF u`,
        [email],
      )

      let userId
      if (existing.rowCount) {
        if (existing.rows[0].has_credential || existing.rows[0].status !== 'pending') {
          const error = new Error('account exists')
          error.code = 'ACCOUNT_EXISTS'
          throw error
        }
        userId = existing.rows[0].id
        await client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId])
        const activatedMemberships = await client.query(
          `UPDATE memberships SET status = 'active', updated_at = now()
           WHERE user_id = $1 AND status = 'invited'
           RETURNING id, organization_id`,
          [userId],
        )
        for (const membership of activatedMemberships.rows) {
          await appendAuditEvent(client, {
            organizationId: membership.organization_id,
            actorMembershipId: membership.id,
            action: 'membership.activated',
            targetType: 'membership',
            targetId: membership.id,
            minimalMetadata: { previousStatus: 'invited' },
          })
        }
      } else {
        userId = randomUUID()
        await client.query(
          `INSERT INTO users (id, identity_provider_subject, email_normalized, status)
           VALUES ($1, $2, $3, 'active')`,
          [userId, `local:${userId}`, email],
        )
      }
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
        [userId, passwordHash],
      )
      const organizationId = await insertOrganization(client, userId, organizationName, 'registration')
      return { userId, organizationId }
    })
  }

  async findCredentialByEmail(email) {
    const result = await this.pool.query(
      `SELECT u.id AS user_id, u.status, c.password_hash,
         (SELECT m.organization_id FROM memberships m
          JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = u.id AND m.status = 'active' AND o.status = 'active'
          ORDER BY m.created_at LIMIT 1) AS organization_id,
         EXISTS (
           SELECT 1 FROM mfa_totp_factors factor
           WHERE factor.user_id = u.id AND factor.status = 'active'
         ) AS requires_mfa,
         EXISTS (
           SELECT 1 FROM mfa_totp_factors factor
           WHERE factor.user_id = u.id AND factor.status = 'active'
         ) AS mfa_enrolled
       FROM users u JOIN user_credentials c ON c.user_id = u.id
       WHERE u.email_normalized = $1`,
      [email],
    )
    const row = result.rows[0]
    return row
      ? {
          userId: row.user_id,
          status: row.status,
          passwordHash: row.password_hash,
          organizationId: row.organization_id,
          requiresMfa: row.requires_mfa,
          mfaEnrolled: row.mfa_enrolled,
        }
      : null
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      `SELECT id AS user_id, status FROM users WHERE email_normalized = $1`,
      [email],
    )
    const row = result.rows[0]
    return row ? { userId: row.user_id, status: row.status } : null
  }

  async getPreferredOrganizationId(userId) {
    const result = await this.pool.query(
      `SELECT membership.organization_id
       FROM memberships membership
       JOIN organizations organization
         ON organization.id = membership.organization_id AND organization.status = 'active'
       WHERE membership.user_id = $1 AND membership.status = 'active'
       ORDER BY membership.created_at
       LIMIT 1`,
      [userId],
    )
    return result.rows[0]?.organization_id ?? null
  }

  async createSession({ userId, organizationId, tokenHash, expiresAt, mfaVerified = false }) {
    await this.pool.query(
      `INSERT INTO sessions (user_id, organization_id, token_hash, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)`,
      [userId, organizationId, tokenHash, expiresAt, mfaVerified],
    )
    await this.pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId])
  }

  async getSession(tokenHash) {
    const result = await this.pool.query(
      `SELECT s.id, s.user_id, s.organization_id, s.expires_at, u.email_normalized
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.status = 'active'
         AND (
           s.mfa_verified_at IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM mfa_totp_factors factor
             WHERE factor.user_id = s.user_id AND factor.status = 'active'
           )
         )`,
      [tokenHash],
    )
    if (!result.rowCount) return null
    const row = result.rows[0]
    const memberships = await this.pool.query(
      `SELECT o.id, o.trade_name AS name, r.code AS role_code, r.name AS role_name,
              COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
       JOIN roles r ON r.id = m.role_id AND r.organization_id = m.organization_id
       LEFT JOIN role_permissions rp
         ON rp.organization_id = r.organization_id AND rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE m.user_id = $1 AND m.status = 'active'
       GROUP BY o.id, o.trade_name, r.code, r.name
       ORDER BY o.trade_name, o.id`,
      [row.user_id],
    )
    const organizations = memberships.rows.map((organization) => ({
      id: organization.id,
      name: organization.name,
      roleCode: organization.role_code,
      roleName: organization.role_name,
      permissions: organization.permissions,
    }))
    const selected = organizations.some(({ id }) => id === row.organization_id)
      ? row.organization_id
      : organizations[0]?.id ?? null
    if (selected !== row.organization_id) {
      await this.pool.query(`UPDATE sessions SET organization_id = $1 WHERE id = $2`, [selected, row.id])
    }
    return {
      user: { id: row.user_id, email: row.email_normalized },
      organizationId: selected,
      organizations,
      expiresAt: row.expires_at,
    }
  }

  async revokeSession(tokenHash) {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    )
  }

  async selectOrganization(tokenHash, organizationId) {
    const result = await this.pool.query(
      `UPDATE sessions s SET organization_id = $2
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND EXISTS (
           SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
           WHERE m.user_id = s.user_id AND m.organization_id = $2
             AND m.status = 'active' AND o.status = 'active'
         )
       RETURNING s.id`,
      [tokenHash, organizationId],
    )
    return Boolean(result.rowCount)
  }

  createOrganization({ userId, name }) {
    return inTransaction(this.pool, (client) => insertOrganization(client, userId, name, 'authenticated'))
  }

  async createPasswordReset({ userId, tokenHash, expiresAt }) {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE password_reset_tokens SET consumed_at = now()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      )
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt],
      )
    })
  }

  consumePasswordReset({ tokenHash, passwordHash }) {
    return inTransaction(this.pool, async (client) => {
      const token = await client.query(
        `UPDATE password_reset_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [tokenHash],
      )
      if (!token.rowCount) return false
      const userId = token.rows[0].user_id
      await client.query(
        `UPDATE user_credentials
         SET password_hash = $1, password_changed_at = now()
         WHERE user_id = $2`,
        [passwordHash, userId],
      )
      await client.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
      await appendUserAuditEvents(client, {
        userId,
        action: 'identity.password_reset.completed',
        minimalMetadata: { method: 'recovery_token' },
      })
      return true
    })
  }

  createMfaChallenge({ userId, tokenHash, purpose, secretEncrypted, expiresAt }) {
    return inTransaction(this.pool, async (client) => {
      const recentFailures = await client.query(
        `SELECT COALESCE(sum(attempts), 0)::int AS count
         FROM mfa_challenges
         WHERE user_id = $1 AND created_at > now() - interval '15 minutes'`,
        [userId],
      )
      if (recentFailures.rows[0].count >= 10) {
        throw new ServiceError(429, 'MFA_RATE_LIMITED', 'Muitas tentativas. Aguarde um pouco e tente novamente.')
      }
      await client.query(
        `UPDATE mfa_challenges SET consumed_at = now()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      )
      const challenge = await client.query(
        `INSERT INTO mfa_challenges
          (user_id, token_hash, purpose, secret_encrypted, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [userId, tokenHash, purpose, secretEncrypted ?? null, expiresAt],
      )
      return challenge.rows[0].id
    })
  }

  async getMfaChallenge(tokenHash) {
    const result = await this.pool.query(
      `SELECT challenge.id, challenge.user_id, challenge.purpose,
              challenge.secret_encrypted AS enrollment_secret_encrypted,
              factor.id AS factor_id, factor.secret_encrypted AS factor_secret_encrypted,
              factor.last_used_step, app_user.email_normalized AS email
       FROM mfa_challenges challenge
       JOIN users app_user ON app_user.id = challenge.user_id AND app_user.status = 'active'
       LEFT JOIN mfa_totp_factors factor
         ON factor.user_id = challenge.user_id AND factor.status = 'active'
       WHERE challenge.token_hash = $1
         AND challenge.consumed_at IS NULL
         AND challenge.expires_at > now()
         AND challenge.attempts < 5`,
      [tokenHash],
    )
    const row = result.rows[0]
    return row ? {
      id: row.id,
      userId: row.user_id,
      purpose: row.purpose,
      email: row.email,
      factorId: row.factor_id,
      secretEncrypted: row.enrollment_secret_encrypted ?? row.factor_secret_encrypted,
      lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    } : null
  }

  async recordMfaFailure(challengeId) {
    await this.pool.query(
      `UPDATE mfa_challenges
       SET attempts = LEAST(attempts + 1, 5),
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE consumed_at END
       WHERE id = $1 AND consumed_at IS NULL`,
      [challengeId],
    )
  }

  completeMfaEnrollment({ challengeId, userId, secretEncrypted, lastUsedStep, recoveryCodeHashes }) {
    return inTransaction(this.pool, async (client) => {
      const challenge = await client.query(
        `SELECT id FROM mfa_challenges
         WHERE id = $1 AND user_id = $2 AND purpose = 'enrollment'
           AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         FOR UPDATE`,
        [challengeId, userId],
      )
      if (!challenge.rowCount) return false

      await client.query(
        `INSERT INTO mfa_totp_factors
          (user_id, secret_encrypted, status, verified_at, last_used_step)
         VALUES ($1, $2, 'active', now(), $3)
         ON CONFLICT (user_id) DO UPDATE
           SET secret_encrypted = EXCLUDED.secret_encrypted,
               status = 'active', verified_at = now(), last_used_step = EXCLUDED.last_used_step,
               revoked_at = NULL`,
        [userId, secretEncrypted, lastUsedStep],
      )
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId])
      for (const codeHash of recoveryCodeHashes) {
        await client.query(
          'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
          [userId, codeHash],
        )
      }
      await client.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [challengeId])
      await client.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
      await appendUserAuditEvents(client, {
        userId,
        actorUserId: userId,
        action: 'identity.mfa.enrolled',
        minimalMetadata: { factor: 'totp' },
      })
      return true
    })
  }

  completeMfaAuthentication({ challengeId, factorId, userId, step }) {
    return inTransaction(this.pool, async (client) => {
      const challenge = await client.query(
        `SELECT id FROM mfa_challenges
         WHERE id = $1 AND user_id = $2 AND purpose = 'authentication'
           AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         FOR UPDATE`,
        [challengeId, userId],
      )
      if (!challenge.rowCount) return false
      const factor = await client.query(
        `UPDATE mfa_totp_factors SET last_used_step = $3
         WHERE id = $1 AND user_id = $2 AND status = 'active'
           AND (last_used_step IS NULL OR last_used_step < $3)
         RETURNING id`,
        [factorId, userId, step],
      )
      if (!factor.rowCount) return false
      await client.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [challengeId])
      return true
    })
  }

  consumeMfaRecoveryCode({ challengeId, userId, codeHash }) {
    return inTransaction(this.pool, async (client) => {
      const challenge = await client.query(
        `SELECT id FROM mfa_challenges
         WHERE id = $1 AND user_id = $2 AND purpose = 'authentication'
           AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         FOR UPDATE`,
        [challengeId, userId],
      )
      if (!challenge.rowCount) return false
      const recoveryCode = await client.query(
        `UPDATE mfa_recovery_codes SET used_at = now()
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
         RETURNING id`,
        [userId, codeHash],
      )
      if (!recoveryCode.rowCount) return false
      await client.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [challengeId])
      await appendUserAuditEvents(client, {
        userId,
        actorUserId: userId,
        action: 'identity.mfa.recovery_code.used',
        minimalMetadata: { factor: 'recovery_code' },
      })
      return true
    })
  }

  async #requirePermission(client, actorUserId, organizationId, permissionCode) {
    const actor = await client.query(
      `SELECT m.id, r.code AS role_code, professional.id AS professional_id
       FROM memberships m
       JOIN roles r ON r.organization_id = m.organization_id AND r.id = m.role_id
       JOIN role_permissions rp ON rp.organization_id = r.organization_id AND rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       LEFT JOIN professionals professional
         ON professional.organization_id = m.organization_id
        AND professional.membership_id = m.id
        AND professional.active AND professional.deleted_at IS NULL
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'
         AND p.code = $3`,
      [actorUserId, organizationId, permissionCode],
    )
    if (!actor.rowCount) {
      throw new ServiceError(403, 'PERMISSION_DENIED', 'Você não tem permissão para esta ação.')
    }
    return actor.rows[0]
  }

  async #requireAnyPermission(client, actorUserId, organizationId, permissionCodes) {
    const actor = await client.query(
      `SELECT m.id, r.code AS role_code, professional.id AS professional_id
       FROM memberships m
       JOIN roles r ON r.organization_id = m.organization_id AND r.id = m.role_id
       JOIN role_permissions rp ON rp.organization_id = r.organization_id AND rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       LEFT JOIN professionals professional
         ON professional.organization_id = m.organization_id
        AND professional.membership_id = m.id
        AND professional.active AND professional.deleted_at IS NULL
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'
         AND p.code = ANY($3::text[])
       LIMIT 1`,
      [actorUserId, organizationId, permissionCodes],
    )
    if (!actor.rowCount) {
      throw new ServiceError(403, 'PERMISSION_DENIED', 'Você não tem permissão para esta ação.')
    }
    return actor.rows[0]
  }

  async #requireClientIdentity(client, actorUserId, organizationId, permissionCode) {
    const actor = await this.#requirePermission(client, actorUserId, organizationId, permissionCode)
    const linked = await client.query(
      `SELECT id, full_name, birth_date, client_type, status, created_at, updated_at
       FROM clients
       WHERE organization_id = $1 AND user_id = $2
         AND status = 'active' AND deleted_at IS NULL`,
      [organizationId, actorUserId],
    )
    if (!linked.rowCount) {
      throw new ServiceError(
        404, 'CLIENT_LINK_NOT_FOUND', 'Seu cadastro de cliente não foi encontrado nesta clínica.',
      )
    }
    return { actor, client: linked.rows[0] }
  }

  async listMemberships({ actorUserId, organizationId }) {
    await this.#requirePermission(this.pool, actorUserId, organizationId, 'memberships.read')
    const result = await this.pool.query(
      `SELECT m.id, u.email_normalized AS email, m.status,
              r.code AS role_code, r.name AS role_name, m.created_at,
              p.id AS professional_id, p.display_name AS professional_name,
              p.registration_number AS professional_registration_number,
              oi.token_ciphertext, oi.expires_at AS invite_expires_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN roles r ON r.organization_id = m.organization_id AND r.id = m.role_id
       LEFT JOIN professionals p
         ON p.organization_id = m.organization_id
        AND p.membership_id = m.id
        AND p.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT token_ciphertext, expires_at
         FROM organization_invitations
         WHERE organization_id = m.organization_id
           AND (email_normalized = u.email_normalized OR email_normalized IS NULL)
           AND status = 'pending'
           AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1
       ) oi ON m.status = 'invited'
       WHERE m.organization_id = $1 AND m.status <> 'revoked'
       ORDER BY u.email_normalized`,
      [organizationId],
    )
    return result.rows.map((membership) => ({
      id: membership.id,
      email: membership.email,
      status: membership.status,
      roleCode: membership.role_code,
      roleName: membership.role_name,
      createdAt: membership.created_at,
      professionalId: membership.professional_id ?? null,
      professionalName: membership.professional_name ?? null,
      registrationNumber: membership.professional_registration_number ?? null,
      tokenCiphertext: membership.token_ciphertext ?? null,
      inviteExpiresAt: membership.invite_expires_at ?? null,
    }))
  }

  inviteMember({ actorUserId, organizationId, email, roleCode, inviteTokenHash, inviteTokenCiphertext, expiresAt }) {
    return inTransaction(this.pool, async (client) => {
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'memberships.manage')
      const role = await client.query(
        `SELECT id, privileged FROM roles WHERE organization_id = $1 AND code = $2`,
        [organizationId, roleCode],
      )
      if (!role.rowCount) throw new ServiceError(400, 'INVALID_ROLE', 'Função inválida.')
      if (role.rows[0].privileged) {
        await this.#requirePermission(client, actorUserId, organizationId, 'roles.manage_privileged')
      }

      const tokenHash = inviteTokenHash ?? hashToken(randomUUID())
      const expiration = expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      const invitation = await client.query(
        `INSERT INTO organization_invitations
           (organization_id, role_id, email_normalized, token_hash, token_ciphertext, invited_by_user_id, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         RETURNING id, expires_at`,
        [organizationId, role.rows[0].id, email ?? null, tokenHash, inviteTokenCiphertext ?? null, actorUserId, expiration],
      )

      let membershipId = invitation.rows[0].id
      let membershipStatus = 'invited'

      if (email) {
        let user = await client.query(`SELECT id FROM users WHERE email_normalized = $1`, [email])
        if (!user.rowCount) {
          const userId = randomUUID()
          user = await client.query(
            `INSERT INTO users (id, identity_provider_subject, email_normalized, status)
             VALUES ($1, $2, $3, 'pending') RETURNING id`,
            [userId, `invite:${userId}`, email],
          )
        }
        const membership = await client.query(
          `INSERT INTO memberships (organization_id, user_id, role_id, status)
           VALUES ($1, $2, $3, 'invited')
           ON CONFLICT (organization_id, user_id) WHERE status <> 'revoked'
           DO UPDATE SET role_id = EXCLUDED.role_id, status = 'invited', updated_at = now()
           RETURNING id, status`,
          [organizationId, user.rows[0].id, role.rows[0].id],
        )
        membershipId = membership.rows[0].id
        membershipStatus = membership.rows[0].status

        await appendAuditEvent(client, {
          organizationId,
          actorMembershipId: actor.id,
          action: 'membership.invited',
          targetType: 'membership',
          targetId: membershipId,
          minimalMetadata: { roleCode, status: membershipStatus },
        })
      }

      return {
        id: membershipId,
        status: membershipStatus,
        invitationId: invitation.rows[0].id,
        expiresAt: invitation.rows[0].expires_at,
      }
    })
  }

  async getInvitationByToken(tokenHash) {
    const result = await this.pool.query(
      `SELECT oi.id, oi.organization_id, oi.role_id, oi.email_normalized, oi.expires_at, oi.status,
              o.trade_name AS organization_name, r.code AS role_code, r.name AS role_name
       FROM organization_invitations oi
       JOIN organizations o ON o.id = oi.organization_id
       JOIN roles r ON r.organization_id = oi.organization_id AND r.id = oi.role_id
       WHERE oi.token_hash = $1 AND oi.status = 'pending' AND oi.expires_at > now()`,
      [tokenHash],
    )
    return result.rows[0] ?? null
  }

  registerAccountViaInvite({ inviteTokenHash, email, passwordHash }) {
    return inTransaction(this.pool, async (client) => {
      const inviteResult = await client.query(
        `SELECT oi.id, oi.organization_id, oi.role_id, oi.email_normalized, oi.status, oi.expires_at
         FROM organization_invitations oi
         WHERE oi.token_hash = $1 FOR UPDATE`,
        [inviteTokenHash],
      )
      if (!inviteResult.rowCount) {
        throw new ServiceError(400, 'INVALID_INVITE', 'Convite inválido ou não encontrado.')
      }
      const invitation = inviteResult.rows[0]
      if (invitation.status !== 'pending' || new Date(invitation.expires_at) <= new Date()) {
        throw new ServiceError(400, 'INVITE_EXPIRED', 'Este convite já foi utilizado ou expirou.')
      }

      const targetEmail = invitation.email_normalized ?? email
      if (!targetEmail) {
        throw new ServiceError(400, 'INVALID_EMAIL', 'Informe um e-mail válido para o cadastro.')
      }

      const existing = await client.query(
        `SELECT u.id, u.status, c.user_id IS NOT NULL AS has_credential
         FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE u.email_normalized = $1 FOR UPDATE OF u`,
        [targetEmail],
      )

      let userId
      if (existing.rowCount) {
        if (existing.rows[0].has_credential) {
          throw new ServiceError(400, 'ACCOUNT_EXISTS', 'Já existe uma conta ativa para este e-mail.')
        }
        userId = existing.rows[0].id
        await client.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`, [userId])
      } else {
        userId = randomUUID()
        await client.query(
          `INSERT INTO users (id, identity_provider_subject, email_normalized, status)
           VALUES ($1, $2, $3, 'active')`,
          [userId, `local:${userId}`, targetEmail],
        )
      }

      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
        [userId, passwordHash],
      )

      const membershipCheck = await client.query(
        `SELECT id, status FROM memberships
         WHERE organization_id = $1 AND user_id = $2`,
        [invitation.organization_id, userId],
      )

      let membershipId
      if (membershipCheck.rowCount) {
        membershipId = membershipCheck.rows[0].id
        await client.query(
          `UPDATE memberships SET role_id = $1, status = 'active', updated_at = now()
           WHERE id = $2`,
          [invitation.role_id, membershipId],
        )
      } else {
        const newMembership = await client.query(
          `INSERT INTO memberships (organization_id, user_id, role_id, status)
           VALUES ($1, $2, $3, 'active') RETURNING id`,
          [invitation.organization_id, userId, invitation.role_id],
        )
        membershipId = newMembership.rows[0].id
      }

      await client.query(
        `UPDATE organization_invitations
         SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $1, updated_at = now()
         WHERE id = $2`,
        [userId, invitation.id],
      )

      await appendAuditEvent(client, {
        organizationId: invitation.organization_id,
        actorMembershipId: membershipId,
        action: 'membership.activated',
        targetType: 'membership',
        targetId: membershipId,
        minimalMetadata: { previousStatus: 'invited', invitationId: invitation.id },
      })

      return { userId, organizationId: invitation.organization_id }
    })
  }

  revokeMembership({ actorUserId, organizationId, membershipId }) {
    return inTransaction(this.pool, async (client) => {
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'memberships.manage')
      const target = await client.query(
        `SELECT m.user_id, m.status, r.code, r.privileged FROM memberships m
         JOIN roles r ON r.organization_id = m.organization_id AND r.id = m.role_id
         WHERE m.id = $1 AND m.organization_id = $2 AND m.status <> 'revoked' FOR UPDATE`,
        [membershipId, organizationId],
      )
      if (!target.rowCount) return false
      if (target.rows[0].privileged) {
        await this.#requirePermission(client, actorUserId, organizationId, 'roles.manage_privileged')
      }
      if (target.rows[0].user_id === actorUserId) {
        throw new ServiceError(400, 'SELF_REVOCATION', 'Não é possível revogar o próprio vínculo por este fluxo.')
      }
      if (target.rows[0].code === 'owner') {
        const owners = await client.query(
          `SELECT count(*)::int AS count FROM memberships m
           JOIN roles r ON r.organization_id = m.organization_id AND r.id = m.role_id
           WHERE m.organization_id = $1 AND m.status = 'active' AND r.code = 'owner'`,
          [organizationId],
        )
        if (owners.rows[0].count <= 1) {
          throw new ServiceError(400, 'LAST_OWNER', 'A organização precisa manter um proprietário ativo.')
        }
      }
      await client.query(
        `UPDATE memberships SET status = 'revoked', revoked_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [membershipId, organizationId],
      )
      await client.query(
        `UPDATE organization_invitations
         SET status = 'revoked', updated_at = now()
         WHERE organization_id = $1 AND (accepted_by_user_id = $2 OR (email_normalized = (SELECT email_normalized FROM users WHERE id = $2) AND status = 'pending'))`,
        [organizationId, target.rows[0].user_id],
      )
      await client.query(
        `UPDATE sessions SET organization_id = NULL
         WHERE user_id = $1 AND organization_id = $2`,
        [target.rows[0].user_id, organizationId],
      )
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'membership.revoked',
        targetType: 'membership',
        targetId: membershipId,
        minimalMetadata: { roleCode: target.rows[0].code, previousStatus: target.rows[0].status },
      })
      return true
    })
  }

  listClients({
    actorUserId, organizationId, clientType = null, search = null, contactSearch = search,
    page = 1, pageSize = 20,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'clients.read')
      const searchPattern = containsPattern(search)
      const contactPattern = containsPattern(contactSearch)
      const foldedName = foldedText('client.full_name')
      const foldedContact = foldedText('matched_contact.normalized_value')
      const where = `client.organization_id = $1 AND client.deleted_at IS NULL
           AND ($2::text IS NULL OR client.client_type = $2)
           AND ($3::text IS NULL
             OR ${foldedName} LIKE $3 ESCAPE E'\\\\'
             OR EXISTS (
               SELECT 1 FROM client_contacts matched_contact
               WHERE matched_contact.organization_id = client.organization_id
                 AND matched_contact.client_id = client.id
                 AND (${foldedContact} LIKE $3 ESCAPE E'\\\\'
                   OR ${foldedContact} LIKE $4 ESCAPE E'\\\\')
             ))`
      const totalResult = await client.query(
        `SELECT count(*)::int AS total FROM clients client WHERE ${where}`,
        [organizationId, clientType, searchPattern, contactPattern],
      )
      const result = await client.query(
        `SELECT client.id, client.full_name, client.birth_date, client.document_number,
                client.client_type, client.status, client.created_at, client.updated_at
         FROM clients client
         WHERE ${where}
         ORDER BY client.full_name, client.id
         LIMIT $5 OFFSET $6`,
        [organizationId, clientType, searchPattern, contactPattern, pageSize, (page - 1) * pageSize],
      )
      if (!result.rowCount) return { items: [], total: totalResult.rows[0].total }
      const contacts = await client.query(
        `SELECT id, client_id, type, value, preferred FROM client_contacts
         WHERE organization_id = $1 AND client_id = ANY($2::uuid[])
         ORDER BY preferred DESC, type, value`,
        [organizationId, result.rows.map(({ id }) => id)],
      )
      const contactsByClient = new Map()
      for (const contact of contacts.rows) {
        const current = contactsByClient.get(contact.client_id) ?? []
        current.push(contact)
        contactsByClient.set(contact.client_id, current)
      }
      return {
        items: result.rows.map((row) => mapClient(row, contactsByClient.get(row.id) ?? [])),
        total: totalResult.rows[0].total,
      }
    })
  }

  getReportFilters({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const [units, professionals, modalities] = await Promise.all([
        client.query(
          `SELECT id, name FROM units
           WHERE organization_id = $1 AND active
           ORDER BY name, id`,
          [organizationId],
        ),
        client.query(
          `SELECT id, display_name FROM professionals
           WHERE organization_id = $1 AND active AND deleted_at IS NULL
           ORDER BY display_name, id`,
          [organizationId],
        ),
        client.query(
          `SELECT id, name FROM modalities
           WHERE organization_id = $1 AND active
           ORDER BY name, id`,
          [organizationId],
        ),
      ])
      return {
        units: units.rows,
        professionals: professionals.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name,
        })),
        modalities: modalities.rows,
        statuses: [
          { value: 'active', label: 'Ativo' },
          { value: 'inactive', label: 'Inativo' },
        ],
      }
    })
  }

  listBirthdayReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
    page = 1,
    pageSize = 25,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const base = `FROM clients client_record
        JOIN generate_series($2::date, $3::date, interval '1 day') birthday_day
          ON extract(month FROM birthday_day) = extract(month FROM client_record.birth_date)
         AND extract(day FROM birthday_day) = extract(day FROM client_record.birth_date)
        LEFT JOIN LATERAL (
          SELECT COALESCE((
            SELECT allowed_consent.granted_at IS NOT NULL
                   AND allowed_consent.revoked_at IS NULL
            FROM client_consents allowed_consent
            WHERE allowed_consent.organization_id = client_record.organization_id
              AND allowed_consent.client_id = client_record.id
              AND allowed_consent.purpose = 'birthday_contact'
            ORDER BY allowed_consent.updated_at DESC, allowed_consent.created_at DESC,
                     allowed_consent.id DESC
            LIMIT 1
          ), false) AS allowed
        ) consent ON true
        LEFT JOIN LATERAL (
          SELECT contact.id, contact.type, contact.value
          FROM client_contacts contact
          WHERE contact.organization_id = client_record.organization_id
            AND contact.client_id = client_record.id
            AND contact.preferred
          ORDER BY CASE contact.type WHEN 'phone' THEN 0 WHEN 'email' THEN 1 ELSE 2 END,
                   contact.id
          LIMIT 1
        ) preferred_contact ON true
        WHERE client_record.organization_id = $1
          AND client_record.deleted_at IS NULL
          AND client_record.birth_date IS NOT NULL
          AND client_record.status <> 'archived'
          AND ($4::text IS NULL OR client_record.status = $4)
          AND (($5::uuid IS NULL AND $6::uuid IS NULL) OR EXISTS (
            SELECT 1
            FROM appointment_participants participant
            JOIN appointments appointment
              ON appointment.organization_id = participant.organization_id
             AND appointment.id = participant.appointment_id
            WHERE participant.organization_id = client_record.organization_id
              AND participant.client_id = client_record.id
              AND ($5::uuid IS NULL OR appointment.unit_id = $5)
              AND ($6::uuid IS NULL OR appointment.professional_id = $6)
              AND appointment.status <> 'cancelled'
              AND participant.status IN ('booked', 'confirmed', 'attended')
          ))`
      const parameters = [organizationId, from, to, status, unitId, professionalId]
      const totalResult = await client.query(
        `SELECT count(*)::int AS total ${base}`,
        parameters,
      )
      const result = await client.query(
        `SELECT client_record.id, client_record.full_name, client_record.birth_date,
                client_record.status, birthday_day::date AS occurs_on,
                (consent.allowed AND preferred_contact.id IS NOT NULL) AS contact_allowed,
                CASE WHEN consent.allowed THEN preferred_contact.type END AS contact_type,
                CASE WHEN consent.allowed THEN preferred_contact.value END AS contact_value
         ${base}
         ORDER BY birthday_day, client_record.full_name, client_record.id
         LIMIT $7 OFFSET $8`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      return {
        total: totalResult.rows[0].total,
        items: result.rows.map((row) => ({
          clientId: row.id,
          fullName: row.full_name,
          birthDate: dateOnly(row.birth_date),
          occursOn: dateOnly(row.occurs_on),
          status: row.status,
          contactAllowed: row.contact_allowed,
          preferredContact: row.contact_allowed
            ? { type: row.contact_type, value: row.contact_value }
            : null,
        })),
      }
    })
  }

  listClientReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
    clientType = 'all',
    page = 1,
    pageSize = 25,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const base = `FROM clients client_record
        LEFT JOIN LATERAL (
          SELECT contract.id, plan.name, contract.starts_on, contract.ends_on
          FROM contracts contract
          JOIN plans plan
            ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
          WHERE contract.organization_id = client_record.organization_id
            AND contract.client_id = client_record.id
            AND contract.status = 'active'
            AND contract.starts_on <= $3::date
            AND (contract.ends_on IS NULL OR contract.ends_on >= $2::date)
          ORDER BY contract.starts_on DESC, contract.id
          LIMIT 1
        ) current_plan ON true
        WHERE client_record.organization_id = $1
          AND client_record.deleted_at IS NULL
          AND client_record.status <> 'archived'
          AND client_record.created_at::date BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR client_record.status = $4)
          AND ($7::text = 'all' OR client_record.client_type = $7)
          AND (($5::uuid IS NULL AND $6::uuid IS NULL) OR EXISTS (
            SELECT 1
            FROM appointment_participants participant
            JOIN appointments appointment
              ON appointment.organization_id = participant.organization_id
             AND appointment.id = participant.appointment_id
            WHERE participant.organization_id = client_record.organization_id
              AND participant.client_id = client_record.id
              AND ($5::uuid IS NULL OR appointment.unit_id = $5)
              AND ($6::uuid IS NULL OR appointment.professional_id = $6)
              AND appointment.status <> 'cancelled'
              AND participant.status IN ('booked', 'confirmed', 'attended')
          ))`
      const parameters = [
        organizationId, from, to, status, unitId, professionalId, clientType,
      ]
      const totalsResult = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE client_record.client_type = 'fixed')::int AS fixed,
                count(*) FILTER (WHERE client_record.client_type = 'rotating')::int AS rotating,
                count(*) FILTER (WHERE client_record.status = 'active')::int AS active,
                count(*) FILTER (WHERE client_record.status = 'inactive')::int AS inactive
         ${base}`,
        parameters,
      )
      const result = await client.query(
        `SELECT client_record.id, client_record.full_name, client_record.client_type,
                client_record.status, client_record.created_at::date AS registered_on,
                current_plan.id AS contract_id, current_plan.name AS plan_name,
                current_plan.starts_on AS plan_starts_on, current_plan.ends_on AS plan_ends_on
         ${base}
         ORDER BY client_record.full_name, client_record.id
         LIMIT $8 OFFSET $9`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      const totals = totalsResult.rows[0]
      return {
        totals: {
          total: totals.total,
          fixed: totals.fixed,
          rotating: totals.rotating,
          active: totals.active,
          inactive: totals.inactive,
        },
        items: result.rows.map((row) => ({
          clientId: row.id,
          fullName: row.full_name,
          clientType: row.client_type,
          status: row.status,
          registeredOn: dateOnly(row.registered_on),
          plan: row.contract_id ? {
            contractId: row.contract_id,
            name: row.plan_name,
            startsOn: dateOnly(row.plan_starts_on),
            endsOn: dateOnly(row.plan_ends_on),
          } : null,
        })),
      }
    })
  }

  listClientActivityReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
    granularity = 'month',
    bucket = null,
    page = 1,
    pageSize = 25,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const interval = granularity === 'year' ? '1 year' : '1 month'
      const periodFormat = granularity === 'year' ? 'YYYY' : 'YYYY-MM'
      const activity = `FROM appointment_participants participant
        JOIN appointments appointment
          ON appointment.organization_id = participant.organization_id
         AND appointment.id = participant.appointment_id
        JOIN units unit
          ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
        JOIN clients client_record
          ON client_record.organization_id = participant.organization_id
         AND client_record.id = participant.client_id
        WHERE participant.organization_id = $1
          AND participant.status = 'attended'
          AND appointment.status <> 'cancelled'
          AND client_record.deleted_at IS NULL
          AND client_record.status <> 'archived'
          AND (appointment.starts_at AT TIME ZONE unit.timezone)::date BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR client_record.status = $4)
          AND ($5::uuid IS NULL OR appointment.unit_id = $5)
          AND ($6::uuid IS NULL OR appointment.professional_id = $6)`
      const parameters = [organizationId, from, to, status, unitId, professionalId]
      const summary = await client.query(
        `WITH periods AS (
           SELECT generated::date AS starts_on
           FROM generate_series(
             date_trunc('${granularity}', $2::date)::date,
             date_trunc('${granularity}', $3::date)::date,
             interval '${interval}'
           ) generated
         ), activity AS (
           SELECT participant.client_id,
                  (appointment.starts_at AT TIME ZONE unit.timezone)::date AS occurred_on
           ${activity}
         )
         SELECT to_char(period.starts_on, '${periodFormat}') AS period,
                greatest(period.starts_on, $2::date) AS period_start,
                least((period.starts_on + interval '${interval} - 1 day')::date, $3::date) AS period_end,
                count(DISTINCT activity.client_id)::int AS active_clients,
                count(activity.client_id)::int AS attendances
         FROM periods period
         LEFT JOIN activity
           ON activity.occurred_on >= period.starts_on
          AND activity.occurred_on < period.starts_on + interval '${interval}'
         GROUP BY period.starts_on
         ORDER BY period.starts_on`,
        parameters,
      )
      const items = summary.rows.map((row) => ({
        period: row.period,
        periodStart: dateOnly(row.period_start),
        periodEnd: dateOnly(row.period_end),
        activeClients: row.active_clients,
        attendances: row.attendances,
      }))
      if (!bucket) return { items, details: [], detailTotal: 0 }

      const bucketStart = granularity === 'year' ? `${bucket}-01-01` : `${bucket}-01`
      const detailBase = `${activity}
          AND (appointment.starts_at AT TIME ZONE unit.timezone)::date >= $7::date
          AND (appointment.starts_at AT TIME ZONE unit.timezone)::date
              < $7::date + interval '${interval}'`
      const detailParameters = [...parameters, bucketStart]
      const detailTotal = await client.query(
        `SELECT count(DISTINCT participant.client_id)::int AS total ${detailBase}`,
        detailParameters,
      )
      const details = await client.query(
        `SELECT client_record.id, client_record.full_name, client_record.client_type,
                client_record.status, count(*)::int AS attendances,
                max((appointment.starts_at AT TIME ZONE unit.timezone)::date) AS last_attendance_on
         ${detailBase}
         GROUP BY client_record.id, client_record.full_name,
                  client_record.client_type, client_record.status
         ORDER BY client_record.full_name, client_record.id
         LIMIT $8 OFFSET $9`,
        [...detailParameters, pageSize, (page - 1) * pageSize],
      )
      return {
        items,
        detailTotal: detailTotal.rows[0].total,
        details: details.rows.map((row) => ({
          clientId: row.id,
          fullName: row.full_name,
          clientType: row.client_type,
          status: row.status,
          attendances: row.attendances,
          lastAttendanceOn: dateOnly(row.last_attendance_on),
        })),
      }
    })
  }

  getBusinessDashboardReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const parameters = [organizationId, from, to, status, unitId, professionalId]
      const financialScope = `client_record.organization_id = $1
        AND client_record.deleted_at IS NULL
        AND client_record.status <> 'archived'
        AND ($4::text IS NULL OR client_record.status = $4)
        AND (($5::uuid IS NULL AND $6::uuid IS NULL) OR EXISTS (
          SELECT 1
          FROM appointment_participants scoped_participant
          JOIN appointments scoped_appointment
            ON scoped_appointment.organization_id = scoped_participant.organization_id
           AND scoped_appointment.id = scoped_participant.appointment_id
          WHERE scoped_participant.organization_id = client_record.organization_id
            AND scoped_participant.client_id = client_record.id
            AND ($5::uuid IS NULL OR scoped_appointment.unit_id = $5)
            AND ($6::uuid IS NULL OR scoped_appointment.professional_id = $6)
            AND scoped_appointment.status <> 'cancelled'
            AND scoped_participant.status IN ('booked', 'confirmed', 'attended')
        ))`
      const financial = await client.query(
        `WITH billed AS (
           SELECT COALESCE(sum(receivable.original_amount_cents), 0)::bigint AS amount
           FROM receivables receivable
           JOIN clients client_record
             ON client_record.organization_id = receivable.organization_id
            AND client_record.id = receivable.client_id
           WHERE ${financialScope}
             AND receivable.status <> 'cancelled'
             AND receivable.competence_on BETWEEN $2::date AND $3::date
         ), received AS (
           SELECT COALESCE(sum(payment.amount_cents), 0)::bigint AS amount
           FROM payments payment
           JOIN receivables receivable
             ON receivable.organization_id = payment.organization_id
            AND receivable.id = payment.receivable_id
           JOIN clients client_record
             ON client_record.organization_id = receivable.organization_id
            AND client_record.id = receivable.client_id
           WHERE ${financialScope}
             AND payment.paid_at::date BETWEEN $2::date AND $3::date
         ), outstanding AS (
           SELECT COALESCE(sum(greatest(balance.balance_cents, 0)), 0)::bigint AS amount
           FROM receivables receivable
           JOIN receivable_balances balance
             ON balance.organization_id = receivable.organization_id
            AND balance.receivable_id = receivable.id
           JOIN clients client_record
             ON client_record.organization_id = receivable.organization_id
            AND client_record.id = receivable.client_id
           WHERE ${financialScope}
             AND receivable.status <> 'cancelled'
             AND receivable.due_on BETWEEN $2::date AND $3::date
         )
         SELECT billed.amount AS billed_cents,
                received.amount AS received_cents,
                outstanding.amount AS outstanding_cents
         FROM billed, received, outstanding`,
        parameters,
      )
      const operational = await client.query(
        `SELECT count(DISTINCT appointment.id)::int AS appointments,
                count(DISTINCT appointment.id)
                  FILTER (WHERE appointment.status = 'completed')::int AS completed_appointments,
                count(*) FILTER (WHERE participant.status = 'attended')::int AS attendances,
                count(*) FILTER (WHERE participant.status = 'absent')::int AS absences
         FROM appointments appointment
         JOIN units unit
           ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
         JOIN appointment_participants participant
           ON participant.organization_id = appointment.organization_id
          AND participant.appointment_id = appointment.id
         JOIN clients client_record
           ON client_record.organization_id = participant.organization_id
          AND client_record.id = participant.client_id
         WHERE appointment.organization_id = $1
           AND appointment.status <> 'cancelled'
           AND (appointment.starts_at AT TIME ZONE unit.timezone)::date BETWEEN $2::date AND $3::date
           AND client_record.deleted_at IS NULL
           AND client_record.status <> 'archived'
           AND ($4::text IS NULL OR client_record.status = $4)
           AND ($5::uuid IS NULL OR appointment.unit_id = $5)
           AND ($6::uuid IS NULL OR appointment.professional_id = $6)`,
        parameters,
      )
      const financeRow = financial.rows[0]
      const operationRow = operational.rows[0]
      const finalized = operationRow.attendances + operationRow.absences
      return {
        financial: {
          billedCents: Number(financeRow.billed_cents),
          receivedCents: Number(financeRow.received_cents),
          outstandingCents: Number(financeRow.outstanding_cents),
        },
        operational: {
          appointments: operationRow.appointments,
          completedAppointments: operationRow.completed_appointments,
          attendances: operationRow.attendances,
          absences: operationRow.absences,
          attendanceRate: finalized ? Math.round((operationRow.attendances / finalized) * 1000) / 10 : 0,
        },
      }
    })
  }

  listEquipmentUsageReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
    modalityId = null,
    page = 1,
    pageSize = 25,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const parameters = [
        organizationId, from, to, status, unitId, professionalId, modalityId,
      ]
      const usageBase = `FROM appointment_equipment allocation
        JOIN appointments appointment
          ON appointment.organization_id = allocation.organization_id
         AND appointment.id = allocation.appointment_id
        JOIN units unit
          ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
        JOIN equipment equipment_record
          ON equipment_record.organization_id = allocation.organization_id
         AND equipment_record.id = allocation.equipment_id
        JOIN services service
          ON service.organization_id = appointment.organization_id AND service.id = appointment.service_id
        JOIN modalities modality
          ON modality.organization_id = service.organization_id AND modality.id = service.modality_id
        JOIN LATERAL (
          SELECT count(*)::int AS count
          FROM appointment_participants participant
          JOIN clients client_record
            ON client_record.organization_id = participant.organization_id
           AND client_record.id = participant.client_id
          WHERE participant.organization_id = appointment.organization_id
            AND participant.appointment_id = appointment.id
            AND participant.status = 'attended'
            AND client_record.deleted_at IS NULL
            AND client_record.status <> 'archived'
            AND ($4::text IS NULL OR client_record.status = $4)
        ) attendance ON attendance.count > 0
        WHERE allocation.organization_id = $1
          AND appointment.status = 'completed'
          AND (appointment.starts_at AT TIME ZONE unit.timezone)::date BETWEEN $2::date AND $3::date
          AND ($5::uuid IS NULL OR appointment.unit_id = $5)
          AND ($6::uuid IS NULL OR appointment.professional_id = $6)
          AND ($7::uuid IS NULL OR modality.id = $7)`
      const totalsResult = await client.query(
        `SELECT count(DISTINCT allocation.equipment_id)::int AS equipment_types,
                count(DISTINCT appointment.id)::int AS appointments,
                COALESCE(sum(allocation.quantity), 0)::int AS allocated_quantity
         ${usageBase}`,
        parameters,
      )
      const totalResult = await client.query(
        `SELECT count(*)::int AS total FROM (
           SELECT allocation.equipment_id, modality.id
           ${usageBase}
           GROUP BY allocation.equipment_id, modality.id
         ) grouped_usage`,
        parameters,
      )
      const result = await client.query(
        `SELECT equipment_record.id AS equipment_id, equipment_record.name AS equipment_name,
                equipment_record.quantity AS available_quantity,
                unit.id AS unit_id, unit.name AS unit_name,
                modality.id AS modality_id, modality.name AS modality_name,
                count(DISTINCT appointment.id)::int AS appointments,
                sum(allocation.quantity)::int AS allocated_quantity,
                sum(attendance.count)::int AS attendances,
                max((appointment.starts_at AT TIME ZONE unit.timezone)::date) AS last_used_on
         ${usageBase}
         GROUP BY equipment_record.id, equipment_record.name, equipment_record.quantity,
                  unit.id, unit.name, modality.id, modality.name
         ORDER BY appointments DESC, equipment_record.name, modality.name,
                  equipment_record.id, modality.id
         LIMIT $8 OFFSET $9`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      const totals = totalsResult.rows[0]
      return {
        total: totalResult.rows[0].total,
        totals: {
          equipmentTypes: totals.equipment_types,
          appointments: totals.appointments,
          allocatedQuantity: totals.allocated_quantity,
        },
        items: result.rows.map((row) => ({
          equipmentId: row.equipment_id,
          equipmentName: row.equipment_name,
          availableQuantity: row.available_quantity,
          unitId: row.unit_id,
          unitName: row.unit_name,
          modalityId: row.modality_id,
          modalityName: row.modality_name,
          appointments: row.appointments,
          allocatedQuantity: row.allocated_quantity,
          attendances: row.attendances,
          lastUsedOn: dateOnly(row.last_used_on),
        })),
      }
    })
  }

  listProspectReport({
    actorUserId,
    organizationId,
    from,
    to,
    unitId = null,
    professionalId = null,
    status = null,
    page = 1,
    pageSize = 25,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'reports.read')
      const parameters = [organizationId, from, to, status, unitId, professionalId]
      const terminalAt = `CASE
        WHEN prospect.stage = 'converted' THEN prospect.converted_at
        WHEN prospect.stage = 'lost' THEN COALESCE(loss_interaction.occurred_at, prospect.updated_at)
        ELSE NULL
      END`
      const base = `FROM prospects prospect
        LEFT JOIN professionals owner
          ON owner.organization_id = prospect.organization_id
         AND owner.id = prospect.owner_professional_id
        LEFT JOIN clients converted_client
          ON converted_client.organization_id = prospect.organization_id
         AND converted_client.id = prospect.converted_client_id
        LEFT JOIN LATERAL (
          SELECT interaction.occurred_at
          FROM prospect_interactions interaction
          WHERE interaction.organization_id = prospect.organization_id
            AND interaction.prospect_id = prospect.id
            AND interaction.type = 'stage_change'
          ORDER BY interaction.occurred_at DESC, interaction.id DESC
          LIMIT 1
        ) loss_interaction ON prospect.stage = 'lost'
        WHERE prospect.organization_id = $1
          AND (prospect.created_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR converted_client.status = $4)
          AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1
            FROM appointment_participants participant
            JOIN appointments appointment
              ON appointment.organization_id = participant.organization_id
             AND appointment.id = participant.appointment_id
            WHERE participant.organization_id = prospect.organization_id
              AND participant.client_id = prospect.converted_client_id
              AND appointment.unit_id = $5
              AND appointment.status <> 'cancelled'
              AND participant.status IN ('booked', 'confirmed', 'attended')
          ))
          AND ($6::uuid IS NULL OR prospect.owner_professional_id = $6)`
      const totalsResult = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE prospect.stage = 'converted')::int AS converted,
                count(*) FILTER (WHERE prospect.stage = 'lost')::int AS lost,
                count(*) FILTER (WHERE prospect.stage NOT IN ('converted', 'lost'))::int AS open,
                COALESCE(round(
                  avg(GREATEST(extract(epoch FROM (${terminalAt} - prospect.created_at)), 0) / 86400.0)
                    FILTER (WHERE prospect.stage IN ('converted', 'lost'))::numeric,
                  1
                ), 0)::float8 AS average_cycle_days
         ${base}`,
        parameters,
      )
      const stagesResult = await client.query(
        `SELECT prospect.stage, count(*)::int AS count
         ${base}
         GROUP BY prospect.stage`,
        parameters,
      )
      const sourcesResult = await client.query(
        `SELECT prospect.source,
                count(*)::int AS total,
                count(*) FILTER (WHERE prospect.stage = 'converted')::int AS converted,
                count(*) FILTER (WHERE prospect.stage = 'lost')::int AS lost
         ${base}
         GROUP BY prospect.source
         ORDER BY total DESC, prospect.source`,
        parameters,
      )
      const detailsResult = await client.query(
        `SELECT prospect.id, prospect.full_name, prospect.source, prospect.stage,
                prospect.owner_professional_id, owner.display_name AS owner_display_name,
                (prospect.created_at AT TIME ZONE 'UTC')::date AS created_on,
                (${terminalAt} AT TIME ZONE 'UTC')::date AS closed_on,
                CASE WHEN ${terminalAt} IS NULL THEN NULL ELSE round(
                  (GREATEST(extract(epoch FROM (${terminalAt} - prospect.created_at)), 0) / 86400.0)::numeric,
                  1
                )::float8 END AS cycle_days
         ${base}
         ORDER BY prospect.created_at DESC, prospect.full_name, prospect.id
         LIMIT $7 OFFSET $8`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      const totals = totalsResult.rows[0]
      const total = totals.total
      const stageCounts = Object.fromEntries(stagesResult.rows.map((row) => [row.stage, row.count]))
      return {
        totals: {
          total,
          converted: totals.converted,
          lost: totals.lost,
          open: totals.open,
          conversionRate: total ? Math.round((totals.converted / total) * 1000) / 10 : 0,
          lossRate: total ? Math.round((totals.lost / total) * 1000) / 10 : 0,
          averageCycleDays: Number(totals.average_cycle_days),
        },
        stages: {
          new: stageCounts.new ?? 0,
          contacted: stageCounts.contacted ?? 0,
          qualified: stageCounts.qualified ?? 0,
          proposal: stageCounts.proposal ?? 0,
          lost: stageCounts.lost ?? 0,
          converted: stageCounts.converted ?? 0,
        },
        sources: sourcesResult.rows.map((row) => ({
          source: row.source,
          total: row.total,
          converted: row.converted,
          lost: row.lost,
          conversionRate: row.total ? Math.round((row.converted / row.total) * 1000) / 10 : 0,
        })),
        items: detailsResult.rows.map((row) => ({
          prospectId: row.id,
          fullName: row.full_name,
          source: row.source,
          stage: row.stage,
          ownerProfessionalId: row.owner_professional_id,
          ownerDisplayName: row.owner_display_name,
          createdOn: dateOnly(row.created_on),
          closedOn: dateOnly(row.closed_on),
          cycleDays: row.cycle_days === null ? null : Number(row.cycle_days),
        })),
      }
    })
  }

  getClientProfile({ actorUserId, organizationId, clientId, sections }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'clients.read')
      const record = await selectClient(client, organizationId, clientId)
      if (!record) return null

      const profile = {
        client: record,
        access: sections,
        schedule: null,
        plan: null,
        finance: null,
        history: null,
        clinicalRecords: null,
      }

      if (sections.schedule) {
        await this.#requirePermission(client, actorUserId, organizationId, 'schedule.read')
        const appointments = await client.query(
          `SELECT appointment.id, participant.id AS participant_id,
                  service.name AS service_name, unit.name AS unit_name,
                  professional.display_name AS professional_name,
                  professional.registration_number AS professional_registration_number,
                  appointment.starts_at,
                  appointment.ends_at, appointment.status, participant.status AS participant_status
           FROM appointment_participants participant
           JOIN appointments appointment
             ON appointment.organization_id = participant.organization_id
            AND appointment.id = participant.appointment_id
           JOIN services service
             ON service.organization_id = appointment.organization_id AND service.id = appointment.service_id
           JOIN units unit
             ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
           JOIN professionals professional
             ON professional.organization_id = appointment.organization_id
            AND professional.id = appointment.professional_id
           WHERE participant.organization_id = $1 AND participant.client_id = $2
           ORDER BY appointment.starts_at DESC, appointment.id DESC
           LIMIT 20`,
          [organizationId, clientId],
        )
        profile.schedule = appointments.rows.map((row) => ({
          id: row.id,
          participantId: row.participant_id,
          serviceName: row.service_name,
          unitName: row.unit_name,
          professionalName: row.professional_name,
          professionalRegistrationNumber: row.professional_registration_number ?? null,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
          participantStatus: row.participant_status,
        }))
      }

      if (sections.plan || sections.finance) {
        await this.#requirePermission(client, actorUserId, organizationId, 'finance.read')
      }
      if (sections.plan) {
        const contracts = await client.query(
          `SELECT contract.id, contract.plan_id, plan.name AS plan_name, contract.starts_on, contract.ends_on,
                  contract.status, contract.agreed_price_cents, plan.currency
           FROM contracts contract
           JOIN plans plan
             ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
           WHERE contract.organization_id = $1 AND contract.client_id = $2
           ORDER BY contract.starts_on DESC, contract.id DESC
           LIMIT 10`,
          [organizationId, clientId],
        )
        profile.plan = contracts.rows.map((row) => ({
          id: row.id,
          planId: row.plan_id,
          name: row.plan_name,
          startsOn: dateOnly(row.starts_on),
          endsOn: row.ends_on == null ? null : dateOnly(row.ends_on),
          status: row.status,
          agreedPriceCents: Number(row.agreed_price_cents),
          currency: row.currency,
        }))
      }

      if (sections.finance) {
        const receivables = await client.query(
          `SELECT receivable.id, receivable.due_on,
                  ${effectiveReceivableStatusSql} AS status, receivable.currency,
                  balance.original_amount_cents, balance.paid_amount_cents, balance.balance_cents
           FROM receivables receivable
           JOIN receivable_balances balance
             ON balance.organization_id = receivable.organization_id
            AND balance.receivable_id = receivable.id
           WHERE receivable.organization_id = $1 AND receivable.client_id = $2
           ORDER BY receivable.due_on DESC, receivable.id DESC
           LIMIT 20`,
          [organizationId, clientId],
        )
        const items = receivables.rows.map((row) => ({
          id: row.id,
          dueOn: row.due_on,
          status: row.status,
          currency: row.currency,
          originalAmountCents: Number(row.original_amount_cents),
          paidAmountCents: Number(row.paid_amount_cents),
          balanceCents: Number(row.balance_cents),
        }))
        profile.finance = {
          receivables: items,
          openBalanceCents: items
            .filter(({ status }) => status !== 'cancelled')
            .reduce((sum, item) => sum + item.balanceCents, 0),
        }
      }

      if (sections.history) {
        await this.#requirePermission(client, actorUserId, organizationId, 'audit.read')
        const history = await client.query(
          `SELECT event.id, event.action, event.minimal_metadata, event.occurred_at
           FROM audit_events event
           WHERE event.organization_id = $1 AND event.target_type = 'client' AND event.target_id = $2
           ORDER BY event.occurred_at DESC, event.id DESC
           LIMIT 20`,
          [organizationId, clientId],
        )
        profile.history = history.rows.map((row) => ({
          id: row.id,
          action: row.action,
          minimalMetadata: row.minimal_metadata,
          occurredAt: row.occurred_at,
        }))
      }

      if (sections.clinical) {
        await this.#requirePermission(client, actorUserId, organizationId, 'clinical.read')
        const records = await client.query(
          `SELECT cr.id, cr.record_type, cr.content, cr.occurred_at, cr.signed_at,
                  p.id AS professional_id, p.display_name AS professional_name,
                  COALESCE(cr.professional_registration, p.registration_number) AS professional_registration_number
           FROM clinical_records cr
           JOIN professionals p
             ON p.organization_id = cr.organization_id
            AND p.id = cr.author_professional_id
           WHERE cr.organization_id = $1 AND cr.client_id = $2
           ORDER BY cr.occurred_at DESC, cr.id DESC
           LIMIT 50`,
          [organizationId, clientId],
        )
        profile.clinicalRecords = records.rows.map((row) => ({
          id: row.id,
          recordType: row.record_type,
          content: row.content,
          occurredAt: row.occurred_at,
          signedAt: row.signed_at,
          authorProfessional: {
            id: row.professional_id,
            displayName: row.professional_name,
            registrationNumber: row.professional_registration_number ?? null,
          },
        }))
      }

      return profile
    })
  }

  listClientClinicalRecords({ actorUserId, organizationId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'clinical.read')
      const target = await selectClient(client, organizationId, clientId)
      if (!target) return null

      const records = await client.query(
        `SELECT cr.id, cr.record_type, cr.content, cr.occurred_at, cr.signed_at,
                p.id AS professional_id, p.display_name AS professional_name,
                COALESCE(cr.professional_registration, p.registration_number) AS professional_registration_number
         FROM clinical_records cr
         JOIN professionals p
           ON p.organization_id = cr.organization_id
          AND p.id = cr.author_professional_id
         WHERE cr.organization_id = $1 AND cr.client_id = $2
         ORDER BY cr.occurred_at DESC, cr.id DESC
         LIMIT 100`,
        [organizationId, clientId],
      )
      return {
        items: records.rows.map((row) => ({
          id: row.id,
          recordType: row.record_type,
          content: row.content,
          occurredAt: row.occurred_at,
          signedAt: row.signed_at,
          authorProfessional: {
            id: row.professional_id,
            displayName: row.professional_name,
            registrationNumber: row.professional_registration_number ?? null,
          },
        })),
      }
    })
  }

  createClientClinicalRecord({ actorUserId, organizationId, clientId, recordType, content, occurredAt }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'clinical.write')
      const target = await selectClient(client, organizationId, clientId)
      if (!target) {
        throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
      }

      const cleanContent = typeof content === 'string' ? content.trim() : ''
      if (!cleanContent) {
        throw new ServiceError(400, 'INVALID_CLINICAL_CONTENT', 'O conteúdo da evolução é obrigatório.')
      }

      let author = await client.query(
        `SELECT p.id, p.display_name, p.registration_number
         FROM professionals p
         JOIN memberships m
           ON m.organization_id = p.organization_id AND m.id = p.membership_id
         WHERE p.organization_id = $1 AND m.user_id = $2 AND p.active AND p.deleted_at IS NULL
         LIMIT 1`,
        [organizationId, actorUserId],
      )

      if (!author.rowCount) {
        author = await client.query(
          `SELECT p.id, p.display_name, p.registration_number
           FROM professionals p
           WHERE p.organization_id = $1 AND p.active AND p.deleted_at IS NULL
           ORDER BY p.created_at ASC
           LIMIT 1`,
          [organizationId],
        )
      }

      if (!author.rowCount) {
        throw new ServiceError(400, 'NO_ACTIVE_PROFESSIONAL', 'Nenhum profissional habilitado encontrado para assinar o prontuário.')
      }

      const authorRow = author.rows[0]
      const recordId = randomUUID()
      const whenOccurred = occurredAt ? new Date(occurredAt) : new Date()
      const type = (recordType && typeof recordType === 'string' && recordType.trim()) ? recordType.trim() : 'evolucao'

      const inserted = await client.query(
        `INSERT INTO clinical_records (
           id, organization_id, client_id, author_professional_id,
           record_type, content, occurred_at, signed_at, professional_registration
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         RETURNING id, record_type, content, occurred_at, signed_at, professional_registration`,
        [
          recordId, organizationId, clientId, authorRow.id,
          type, cleanContent, whenOccurred, authorRow.registration_number,
        ],
      )

      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'clinical_record.created',
        targetType: 'clinical_record',
        targetId: recordId,
        minimalMetadata: {
          clientId,
          recordType: type,
          authorProfessionalId: authorRow.id,
          hasRegistration: Boolean(authorRow.registration_number),
        },
      })

      const row = inserted.rows[0]
      return {
        id: row.id,
        recordType: row.record_type,
        content: row.content,
        occurredAt: row.occurred_at,
        signedAt: row.signed_at,
        authorProfessional: {
          id: authorRow.id,
          displayName: authorRow.display_name,
          registrationNumber: row.professional_registration ?? authorRow.registration_number ?? null,
        },
      }
    })
  }

  updateProfessional({ actorUserId, organizationId, professionalId, registrationNumber, displayName }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'memberships.manage')
      const target = await client.query(
        `SELECT id, display_name, registration_number FROM professionals
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [organizationId, professionalId],
      )
      if (!target.rowCount) {
        throw new ServiceError(404, 'PROFESSIONAL_NOT_FOUND', 'Profissional não encontrado.')
      }

      const cleanReg = registrationNumber !== undefined ? (String(registrationNumber ?? '').trim() || null) : target.rows[0].registration_number
      const cleanName = displayName !== undefined ? (String(displayName ?? '').trim() || target.rows[0].display_name) : target.rows[0].display_name

      const updated = await client.query(
        `UPDATE professionals
         SET registration_number = $3, display_name = $4, updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING id, display_name, registration_number`,
        [organizationId, professionalId, cleanReg, cleanName],
      )

      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'professional.updated',
        targetType: 'professional',
        targetId: professionalId,
        minimalMetadata: {
          hasRegistration: Boolean(cleanReg),
        },
      })

      const row = updated.rows[0]
      return {
        id: row.id,
        displayName: row.display_name,
        registrationNumber: row.registration_number,
      }
    })
  }

  listPlans({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requireAnyPermission(client, actorUserId, organizationId, [
        'finance.read', 'clients.read', 'clients.manage', 'finance.manage',
      ])
      const result = await client.query(
        `SELECT id, name, price_cents, currency, billing_rule, active, created_at, updated_at
         FROM plans
         WHERE organization_id = $1 AND active = true
         ORDER BY name ASC, id ASC`,
        [organizationId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        priceCents: Number(row.price_cents),
        currency: row.currency,
        billingRule: row.billing_rule,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    })
  }

  createPlan({ actorUserId, organizationId, plan }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const planId = randomUUID()
      const result = await client.query(
        `INSERT INTO plans (id, organization_id, name, price_cents, currency, billing_rule, active)
         VALUES ($1, $2, $3, $4, 'BRL', $5, $6)
         ON CONFLICT (organization_id, name) DO UPDATE
           SET price_cents = EXCLUDED.price_cents,
               billing_rule = EXCLUDED.billing_rule,
               active = true,
               updated_at = now()
         RETURNING id, name, price_cents, currency, billing_rule, active, created_at, updated_at`,
        [planId, organizationId, plan.name, plan.priceCents, JSON.stringify(plan.billingRule ?? { frequency: 'monthly', dueDay: 10 }), plan.active !== false],
      )
      const row = result.rows[0]
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'plan.created',
        targetType: 'plan',
        targetId: row.id,
        minimalMetadata: {
          name: row.name,
          priceCents: Number(row.price_cents),
        },
      })
      return {
        id: row.id,
        name: row.name,
        priceCents: Number(row.price_cents),
        currency: row.currency,
        billingRule: row.billing_rule,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  listClientContracts({ actorUserId, organizationId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requireAnyPermission(client, actorUserId, organizationId, [
        'finance.read', 'clients.read', 'clients.manage', 'finance.manage',
      ])
      const target = await selectClient(client, organizationId, clientId)
      if (!target || target.status === 'archived') {
        throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
      }
      const result = await client.query(
        `SELECT contract.id, contract.client_id, contract.plan_id, plan.name AS plan_name,
                contract.starts_on, contract.ends_on, contract.agreed_price_cents,
                plan.currency, contract.status, contract.created_at, contract.updated_at
         FROM contracts contract
         JOIN plans plan
           ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
         WHERE contract.organization_id = $1 AND contract.client_id = $2
         ORDER BY contract.starts_on DESC, contract.id DESC`,
        [organizationId, clientId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        planId: row.plan_id,
        name: row.plan_name,
        startsOn: row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : String(row.starts_on).slice(0, 10),
        endsOn: row.ends_on ? (row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : String(row.ends_on).slice(0, 10)) : null,
        agreedPriceCents: Number(row.agreed_price_cents),
        currency: row.currency,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    })
  }

  createClientContract({ actorUserId, organizationId, clientId, contract }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requireAnyPermission(client, actorUserId, organizationId, [
        'clients.manage', 'finance.manage',
      ])
      const target = await selectClient(client, organizationId, clientId)
      if (!target || target.status === 'archived') {
        throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
      }

      const planRes = await client.query(
        `SELECT id, name, price_cents, currency
         FROM plans
         WHERE organization_id = $1 AND id = $2 AND active = true`,
        [organizationId, contract.planId],
      )
      if (!planRes.rowCount) {
        throw new ServiceError(404, 'PLAN_NOT_FOUND', 'Plano não encontrado ou inativo.')
      }
      const planRow = planRes.rows[0]
      const agreedPriceCents = contract.agreedPriceCents !== null && contract.agreedPriceCents !== undefined
        ? contract.agreedPriceCents
        : Number(planRow.price_cents)
      const status = contract.status || 'active'
      const contractId = randomUUID()

      const inserted = await client.query(
        `INSERT INTO contracts (
           id, organization_id, client_id, plan_id, starts_on, ends_on, agreed_price_cents, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, client_id, plan_id, starts_on, ends_on, agreed_price_cents, status, created_at, updated_at`,
        [contractId, organizationId, clientId, contract.planId, contract.startsOn, contract.endsOn ?? null, agreedPriceCents, status],
      )

      if (status === 'active' && (target.clientType === 'rotating' || target.client_type === 'rotating')) {
        await client.query(
          `UPDATE clients SET client_type = 'fixed', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [organizationId, clientId],
        )
        await appendAuditEvent(client, {
          organizationId,
          actorMembershipId: actor.id,
          action: 'client.updated',
          targetType: 'client',
          targetId: clientId,
          minimalMetadata: {
            previousClientType: 'rotating',
            clientType: 'fixed',
            reason: 'contract_activated',
          },
        })
      }

      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'contract.created',
        targetType: 'contract',
        targetId: contractId,
        minimalMetadata: {
          clientId,
          planId: contract.planId,
          planName: planRow.name,
          startsOn: contract.startsOn,
          agreedPriceCents,
          status,
        },
      })

      const row = inserted.rows[0]
      return {
        id: row.id,
        clientId: row.client_id,
        planId: row.plan_id,
        name: planRow.name,
        startsOn: row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : String(row.starts_on).slice(0, 10),
        endsOn: row.ends_on ? (row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : String(row.ends_on).slice(0, 10)) : null,
        agreedPriceCents: Number(row.agreed_price_cents),
        currency: planRow.currency,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  updateClientContract({ actorUserId, organizationId, clientId, contractId, patch }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requireAnyPermission(client, actorUserId, organizationId, [
        'clients.manage', 'finance.manage',
      ])
      const target = await selectClient(client, organizationId, clientId)
      if (!target || target.status === 'archived') {
        throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
      }

      const existingRes = await client.query(
        `SELECT contract.*, plan.name AS plan_name, plan.currency
         FROM contracts contract
         JOIN plans plan ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
         WHERE contract.organization_id = $1 AND contract.client_id = $2 AND contract.id = $3
         FOR UPDATE OF contract`,
        [organizationId, clientId, contractId],
      )
      if (!existingRes.rowCount) {
        throw new ServiceError(404, 'CONTRACT_NOT_FOUND', 'Contrato não encontrado.')
      }
      const existing = existingRes.rows[0]

      const newStatus = patch.status ?? existing.status
      const newEndsOn = patch.endsOn !== undefined ? patch.endsOn : existing.ends_on
      const newPriceCents = patch.agreedPriceCents !== undefined ? patch.agreedPriceCents : Number(existing.agreed_price_cents)

      if (newEndsOn && newEndsOn < (existing.starts_on instanceof Date ? existing.starts_on.toISOString().slice(0, 10) : String(existing.starts_on).slice(0, 10))) {
        throw new ServiceError(400, 'INVALID_CONTRACT', 'A data de término não pode ser anterior à data de início.')
      }

      const updated = await client.query(
        `UPDATE contracts
         SET status = $4,
             ends_on = $5,
             agreed_price_cents = $6,
             updated_at = now()
         WHERE organization_id = $1 AND client_id = $2 AND id = $3
         RETURNING id, client_id, plan_id, starts_on, ends_on, agreed_price_cents, status, created_at, updated_at`,
        [organizationId, clientId, contractId, newStatus, newEndsOn, newPriceCents],
      )

      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'contract.updated',
        targetType: 'contract',
        targetId: contractId,
        minimalMetadata: {
          clientId,
          previousStatus: existing.status,
          status: newStatus,
          agreedPriceCents: newPriceCents,
        },
      })

      const row = updated.rows[0]
      return {
        id: row.id,
        clientId: row.client_id,
        planId: row.plan_id,
        name: existing.plan_name,
        startsOn: row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : String(row.starts_on).slice(0, 10),
        endsOn: row.ends_on ? (row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : String(row.ends_on).slice(0, 10)) : null,
        agreedPriceCents: Number(row.agreed_price_cents),
        currency: existing.currency,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  listReplacementCredits({ actorUserId, organizationId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'clients.read')
      const target = await client.query(
        `SELECT id FROM clients
         WHERE organization_id = $1 AND id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [organizationId, clientId],
      )
      if (!target.rowCount) return null
      const result = await client.query(
        `${replacementCreditSelect}
         WHERE credit.organization_id = $1 AND credit.client_id = $2
         ORDER BY credit.created_at DESC, credit.id DESC`,
        [organizationId, clientId],
      )
      const credits = result.rows.map(mapReplacementCredit)
      return {
        balance: credits.filter(({ status }) => status === 'available').length,
        credits,
      }
    })
  }

  issueReplacementCredit({ actorUserId, organizationId, clientId, sourceParticipantId, expiresOn }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const source = await client.query(
        `SELECT participant.client_id, participant.status,
                (appointment.starts_at AT TIME ZONE unit.timezone)::date AS source_date,
                (clock_timestamp() AT TIME ZONE unit.timezone)::date AS local_today,
                organization.replacement_credit_validity_days
         FROM appointment_participants participant
         JOIN appointments appointment
           ON appointment.organization_id = participant.organization_id
          AND appointment.id = participant.appointment_id
         JOIN units unit
           ON unit.organization_id = appointment.organization_id
          AND unit.id = appointment.unit_id
         JOIN organizations organization ON organization.id = participant.organization_id
         WHERE participant.organization_id = $1 AND participant.id = $2
         FOR UPDATE OF participant`,
        [organizationId, sourceParticipantId],
      )
      if (!source.rowCount || source.rows[0].client_id !== clientId) {
        throw new ServiceError(404, 'REPLACEMENT_SOURCE_NOT_FOUND', 'Origem da reposição não encontrada.')
      }
      if (!['absent', 'cancelled'].includes(source.rows[0].status)) {
        throw new ServiceError(
          409, 'REPLACEMENT_SOURCE_NOT_ELIGIBLE',
          'A reposição só pode ser emitida para uma falta ou cancelamento encerrado.',
        )
      }
      const existing = await client.query(
        `SELECT id FROM replacement_credits
         WHERE organization_id = $1 AND source_participant_id = $2`,
        [organizationId, sourceParticipantId],
      )
      if (existing.rowCount) {
        return selectReplacementCredit(client, organizationId, existing.rows[0].id)
      }
      const policyExpiration = new Date(source.rows[0].local_today)
      policyExpiration.setUTCDate(
        policyExpiration.getUTCDate() + source.rows[0].replacement_credit_validity_days,
      )
      const selectedExpiration = expiresOn ?? policyExpiration.toISOString().slice(0, 10)
      if (selectedExpiration < source.rows[0].local_today) {
        throw new ServiceError(
          400, 'INVALID_REPLACEMENT_EXPIRATION', 'A validade da reposição não pode estar no passado.',
        )
      }
      const inserted = await client.query(
        `INSERT INTO replacement_credits
          (organization_id, client_id, source_participant_id, expires_on)
         VALUES ($1, $2, $3, $4::date) RETURNING id`,
        [organizationId, clientId, sourceParticipantId, selectedExpiration],
      )
      const creditId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'replacement_credit.issued', targetType: 'replacement_credit', targetId: creditId,
        minimalMetadata: { clientId, sourceParticipantId, expiresOn: selectedExpiration },
      })
      await client.query(
        `INSERT INTO outbox_events
          (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
         VALUES ($1, 'replacement_credit', $2, 'replacement_credit.issued', '{}'::jsonb, $3)`,
        [organizationId, creditId, `replacement_credit.issued:${creditId}`],
      )
      return selectReplacementCredit(client, organizationId, creditId)
    })
  }

  cancelReplacementCredit({ actorUserId, organizationId, clientId, creditId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT status FROM replacement_credits
         WHERE organization_id = $1 AND client_id = $2 AND id = $3 FOR UPDATE`,
        [organizationId, clientId, creditId],
      )
      if (!current.rowCount) return null
      if (current.rows[0].status === 'cancelled') {
        return selectReplacementCredit(client, organizationId, creditId)
      }
      if (current.rows[0].status !== 'available') {
        throw new ServiceError(
          409, 'REPLACEMENT_CREDIT_NOT_AVAILABLE', 'Somente uma reposição disponível pode ser cancelada.',
        )
      }
      await client.query(
        `UPDATE replacement_credits SET status = 'cancelled'
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, creditId],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'replacement_credit.cancelled', targetType: 'replacement_credit', targetId: creditId,
        minimalMetadata: { clientId },
      })
      await client.query(
        `INSERT INTO outbox_events
          (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
         VALUES ($1, 'replacement_credit', $2, 'replacement_credit.cancelled', '{}'::jsonb, $3)`,
        [organizationId, creditId, `replacement_credit.cancelled:${creditId}`],
      )
      return selectReplacementCredit(client, organizationId, creditId)
    })
  }

  getOwnReplacementCredits({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.read',
      )
      const result = await client.query(
        `${replacementCreditSelect}
         WHERE credit.organization_id = $1 AND credit.client_id = $2
         ORDER BY credit.created_at DESC, credit.id DESC`,
        [organizationId, identity.client.id],
      )
      const credits = result.rows.map(mapReplacementCredit)
      const eligible = await client.query(
        `SELECT appointment.id, appointment.starts_at, appointment.ends_at,
                appointment.capacity,
                service.id AS service_id, service.name AS service_name,
                professional.id AS professional_id,
                professional.display_name AS professional_name,
                unit.id AS unit_id, unit.name AS unit_name, unit.timezone AS unit_timezone,
                room.id AS room_id, room.name AS room_name,
                (SELECT count(*)::int FROM appointment_participants occupied
                 WHERE occupied.organization_id = appointment.organization_id
                   AND occupied.appointment_id = appointment.id
                   AND occupied.status IN ('booked', 'confirmed', 'attended')) AS occupancy
         FROM appointments appointment
         JOIN services service
           ON service.organization_id = appointment.organization_id
          AND service.id = appointment.service_id
         JOIN professionals professional
           ON professional.organization_id = appointment.organization_id
          AND professional.id = appointment.professional_id
         JOIN units unit
           ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
         LEFT JOIN rooms room
           ON room.organization_id = appointment.organization_id AND room.id = appointment.room_id
         WHERE appointment.organization_id = $1
           AND appointment.appointment_type = 'class' AND appointment.status = 'scheduled'
           AND appointment.starts_at > clock_timestamp()
           AND appointment.starts_at <= clock_timestamp() + interval '90 days'
           AND (SELECT count(*) FROM appointment_participants occupied
                WHERE occupied.organization_id = appointment.organization_id
                  AND occupied.appointment_id = appointment.id
                  AND occupied.status IN ('booked', 'confirmed', 'attended')) < appointment.capacity
           AND NOT EXISTS (
             SELECT 1 FROM appointment_participants own_participation
             WHERE own_participation.organization_id = appointment.organization_id
               AND own_participation.appointment_id = appointment.id
               AND own_participation.client_id = $2
               AND own_participation.status IN ('booked', 'confirmed', 'attended')
           )
           AND NOT EXISTS (
             SELECT 1 FROM waitlist_offers offer
             WHERE offer.organization_id = appointment.organization_id
               AND offer.appointment_id = appointment.id
               AND offer.status = 'active' AND offer.expires_at > clock_timestamp()
           )
           AND EXISTS (
             SELECT 1 FROM replacement_credits credit
             JOIN appointment_participants source
               ON source.organization_id = credit.organization_id
              AND source.id = credit.source_participant_id
             JOIN appointments source_appointment
               ON source_appointment.organization_id = source.organization_id
              AND source_appointment.id = source.appointment_id
             JOIN units source_unit
               ON source_unit.organization_id = source_appointment.organization_id
              AND source_unit.id = source_appointment.unit_id
             WHERE credit.organization_id = appointment.organization_id
               AND credit.client_id = $2 AND credit.status = 'available'
               AND credit.expires_on >= (appointment.starts_at AT TIME ZONE unit.timezone)::date
               AND (source_appointment.starts_at AT TIME ZONE source_unit.timezone)::date
                   <= (appointment.starts_at AT TIME ZONE unit.timezone)::date
           )
         ORDER BY appointment.starts_at, appointment.id LIMIT 50`,
        [organizationId, identity.client.id],
      )
      return {
        balance: credits.filter(({ status }) => status === 'available').length,
        credits,
        eligibleAppointments: eligible.rows.map((row) => ({
          id: row.id, startsAt: row.starts_at, endsAt: row.ends_at,
          capacity: row.capacity, occupancy: row.occupancy,
          service: { id: row.service_id, name: row.service_name },
          professional: { id: row.professional_id, displayName: row.professional_name },
          unit: { id: row.unit_id, name: row.unit_name, timezone: row.unit_timezone },
          room: row.room_id ? { id: row.room_id, name: row.room_name } : null,
        })),
      }
    })
  }

  bookOwnAppointmentWithReplacement({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.manage',
      )
      await advanceWaitlistOffer(client, organizationId, appointmentId)
      const appointment = await client.query(
        `SELECT appointment.appointment_type, appointment.status,
                appointment.starts_at > clock_timestamp() AS is_future,
                (appointment.starts_at AT TIME ZONE unit.timezone)::date AS appointment_date
         FROM appointments appointment
         JOIN units unit
           ON unit.organization_id = appointment.organization_id
          AND unit.id = appointment.unit_id
         WHERE appointment.organization_id = $1 AND appointment.id = $2
         FOR UPDATE OF appointment`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) {
        throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      }
      const existing = await client.query(
        `SELECT participant.id, credit.id AS credit_id
         FROM appointment_participants participant
         LEFT JOIN replacement_credits credit
           ON credit.organization_id = participant.organization_id
          AND credit.consumed_by_participant_id = participant.id
         WHERE participant.organization_id = $1 AND participant.appointment_id = $2
           AND participant.client_id = $3
           AND participant.status IN ('booked', 'confirmed', 'attended')
         LIMIT 1`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (existing.rowCount) {
        if (!existing.rows[0].credit_id) {
          throw new ServiceError(409, 'APPOINTMENT_ALREADY_BOOKED', 'Você já participa desta turma.')
        }
        const selected = await client.query(
          `${ownAppointmentSelect}
           WHERE participant.organization_id = $1 AND participant.id = $2`,
          [organizationId, existing.rows[0].id],
        )
        return mapOwnAppointment(selected.rows[0])
      }
      const selectedAppointment = appointment.rows[0]
      if (selectedAppointment.appointment_type !== 'class'
        || selectedAppointment.status !== 'scheduled' || !selectedAppointment.is_future) {
        throw new ServiceError(
          409, 'REPLACEMENT_APPOINTMENT_UNAVAILABLE', 'Esta turma não aceita agendamento por reposição.',
        )
      }
      const activeOffer = await client.query(
        `SELECT id FROM waitlist_offers
         WHERE organization_id = $1 AND appointment_id = $2
           AND status = 'active' AND expires_at > clock_timestamp()`,
        [organizationId, appointmentId],
      )
      if (activeOffer.rowCount) {
        throw new ServiceError(
          409, 'WAITLIST_OFFER_ACTIVE', 'A vaga está reservada temporariamente para a fila de interesse.',
        )
      }
      const inserted = await client.query(
        `INSERT INTO appointment_participants
          (organization_id, appointment_id, client_id, status)
         VALUES ($1, $2, $3, 'confirmed') RETURNING id`,
        [organizationId, appointmentId, identity.client.id],
      )
      const participantId = inserted.rows[0].id
      const creditId = await consumeReplacementCredit(client, {
        organizationId, clientId: identity.client.id, participantId,
        appointmentDate: selectedAppointment.appointment_date,
      })
      if (!creditId) {
        throw new ServiceError(
          409, 'REPLACEMENT_CREDIT_REQUIRED', 'Não existe reposição válida para a data desta turma.',
        )
      }
      await recordReplacementCreditConsumption(client, {
        organizationId, actorMembershipId: identity.actor.id,
        creditId, participantId, appointmentId,
      })
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: identity.actor.id,
        action: 'replacement_booking.created', targetType: 'appointment_participant',
        targetId: participantId, minimalMetadata: { appointmentId, creditId },
      })
      const selected = await client.query(
        `${ownAppointmentSelect}
         WHERE participant.organization_id = $1 AND participant.id = $2`,
        [organizationId, participantId],
      )
      return mapOwnAppointment(selected.rows[0])
    })
  }

  getClientArea({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'clients.own.read',
      )
      const organization = await client.query(
        `SELECT trade_name, self_checkin_enabled,
                self_checkin_before_minutes, self_checkin_after_minutes
         FROM organizations WHERE id = $1`,
        [organizationId],
      )
      if (!organization.rowCount) return null
      const contacts = await client.query(
        `SELECT id, type, value, preferred FROM client_contacts
         WHERE organization_id = $1 AND client_id = $2
         ORDER BY preferred DESC, type, value`,
        [organizationId, identity.client.id],
      )
      const next = await client.query(
        `${ownAppointmentSelect}
         WHERE participant.organization_id = $1 AND participant.client_id = $2
           AND appointment.status = 'scheduled'
           AND participant.status IN ('booked', 'confirmed')
           AND appointment.ends_at >= now()
         ORDER BY appointment.starts_at, appointment.id LIMIT 1`,
        [organizationId, identity.client.id],
      )
      const activeContract = await client.query(
        `SELECT contract.id, contract.plan_id, plan.name AS plan_name,
                contract.starts_on, contract.ends_on, contract.status,
                contract.agreed_price_cents, plan.currency
         FROM contracts contract
         JOIN plans plan
           ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
         WHERE contract.organization_id = $1 AND contract.client_id = $2
           AND contract.status = 'active'
           AND contract.starts_on <= CURRENT_DATE
           AND (contract.ends_on IS NULL OR contract.ends_on >= CURRENT_DATE)
         ORDER BY contract.starts_on DESC, contract.id DESC
         LIMIT 1`,
        [organizationId, identity.client.id],
      )
      const clinic = organization.rows[0]
      return {
        client: mapClient(identity.client, contacts.rows),
        organization: { id: organizationId, name: clinic.trade_name },
        checkInPolicy: {
          enabled: clinic.self_checkin_enabled,
          beforeMinutes: clinic.self_checkin_before_minutes,
          afterMinutes: clinic.self_checkin_after_minutes,
        },
        nextAppointment: next.rowCount ? mapOwnAppointment(next.rows[0]) : null,
        activeContract: activeContract.rowCount ? {
          id: activeContract.rows[0].id,
          planId: activeContract.rows[0].plan_id,
          name: activeContract.rows[0].plan_name,
          startsOn: activeContract.rows[0].starts_on instanceof Date ? activeContract.rows[0].starts_on.toISOString().slice(0, 10) : String(activeContract.rows[0].starts_on).slice(0, 10),
          endsOn: activeContract.rows[0].ends_on ? (activeContract.rows[0].ends_on instanceof Date ? activeContract.rows[0].ends_on.toISOString().slice(0, 10) : String(activeContract.rows[0].ends_on).slice(0, 10)) : null,
          status: activeContract.rows[0].status,
          agreedPriceCents: Number(activeContract.rows[0].agreed_price_cents),
          currency: activeContract.rows[0].currency,
        } : null,
      }
    })
  }

  getOwnInvoices({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'clients.own.read',
      )
      const result = await client.query(
        `WITH listed AS (${receivableSelect}
          WHERE receivable.organization_id = $1 AND receivable.client_id = $2)
         SELECT * FROM listed
         WHERE effective_status IN ('open', 'partially_paid', 'overdue')
         ORDER BY due_on, id`,
        [organizationId, identity.client.id],
      )
      const items = result.rows.map(mapReceivable)
      return {
        items,
        summary: {
          count: items.length,
          openBalanceCents: items.reduce((total, item) => total + item.balanceCents, 0),
          overdueBalanceCents: items.reduce(
            (total, item) => total + (item.status === 'overdue' ? item.balanceCents : 0), 0,
          ),
        },
      }
    })
  }

  getOwnPublishedClinicalContent({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'clinical.published.read',
      )
      const [assessments, workoutPlans] = await Promise.all([
        client.query(
          `SELECT assessment.id, assessment.assessment_type, assessment.structured_data,
                  assessment.assessed_at, professional.id AS professional_id,
                  professional.display_name AS professional_name,
                  professional.registration_number AS professional_registration_number
           FROM assessments assessment
           JOIN professionals professional
             ON professional.organization_id = assessment.organization_id
            AND professional.id = assessment.professional_id
           WHERE assessment.organization_id = $1 AND assessment.client_id = $2
             AND assessment.publication_status = 'published'
           ORDER BY assessment.assessed_at DESC, assessment.id DESC
           LIMIT 100`,
          [organizationId, identity.client.id],
        ),
        client.query(
          `SELECT workout.id, workout.title, workout.instructions, workout.valid_until,
                  workout.created_at, professional.id AS professional_id,
                  professional.display_name AS professional_name,
                  professional.registration_number AS professional_registration_number
           FROM workout_plans workout
           JOIN professionals professional
             ON professional.organization_id = workout.organization_id
            AND professional.id = workout.professional_id
           WHERE workout.organization_id = $1 AND workout.client_id = $2
             AND workout.publication_status = 'published'
           ORDER BY (workout.valid_until IS NULL), workout.valid_until DESC,
                    workout.created_at DESC, workout.id DESC
           LIMIT 100`,
          [organizationId, identity.client.id],
        ),
      ])
      return {
        assessments: assessments.rows.map((row) => ({
          id: row.id,
          type: row.assessment_type,
          data: row.structured_data,
          assessedAt: row.assessed_at,
          professional: {
            id: row.professional_id,
            displayName: row.professional_name,
            registrationNumber: row.professional_registration_number ?? null,
          },
        })),
        workoutPlans: workoutPlans.rows.map((row) => ({
          id: row.id,
          title: row.title,
          instructions: row.instructions,
          validUntil: row.valid_until,
          createdAt: row.created_at,
          professional: {
            id: row.professional_id,
            displayName: row.professional_name,
            registrationNumber: row.professional_registration_number ?? null,
          },
        })),
      }
    })
  }

  getOwnContactChannels({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'clients.own.read',
      )
      const result = await client.query(
        `SELECT id, channel, label, value
         FROM organization_contact_channels
         WHERE organization_id = $1 AND enabled
         ORDER BY position, label, id`,
        [organizationId],
      )
      return {
        channels: result.rows.map((row) => ({
          id: row.id,
          channel: row.channel,
          label: row.label,
          displayValue: row.value,
          href: row.channel === 'email'
            ? `mailto:${row.value}`
            : row.channel === 'whatsapp'
              ? `https://wa.me/${row.value.replace(/\D/gu, '')}`
              : `tel:${row.value}`,
        })),
      }
    })
  }

  getOwnAppointments({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.read',
      )
      const appointments = await client.query(
        `${ownAppointmentSelect}
         WHERE participant.organization_id = $1 AND participant.client_id = $2
         ORDER BY appointment.starts_at DESC, appointment.id DESC LIMIT 200`,
        [organizationId, identity.client.id],
      )
      return { appointments: appointments.rows.map(mapOwnAppointment) }
    })
  }

  selfCheckIn({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.manage',
      )
      const current = await client.query(
        `SELECT participant.id AS participant_id, participant.status AS participant_status,
                appointment.status AS appointment_status, appointment.starts_at,
                organization.self_checkin_enabled,
                organization.self_checkin_before_minutes,
                organization.self_checkin_after_minutes,
                checkin.id AS checkin_id
         FROM appointment_participants participant
         JOIN appointments appointment
           ON appointment.organization_id = participant.organization_id
          AND appointment.id = participant.appointment_id
         JOIN organizations organization ON organization.id = appointment.organization_id
         LEFT JOIN checkins checkin
           ON checkin.organization_id = participant.organization_id
          AND checkin.appointment_participant_id = participant.id
         WHERE participant.organization_id = $1 AND participant.client_id = $2
           AND appointment.id = $3
         FOR UPDATE OF participant, appointment`,
        [organizationId, identity.client.id, appointmentId],
      )
      if (!current.rowCount) {
        throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      }
      const appointment = current.rows[0]
      if (!appointment.checkin_id) {
        if (!appointment.self_checkin_enabled) {
          throw new ServiceError(409, 'SELF_CHECKIN_DISABLED', 'O check-in pelo aplicativo está desativado nesta clínica.')
        }
        if (appointment.appointment_status !== 'scheduled'
          || !['booked', 'confirmed'].includes(appointment.participant_status)) {
          throw new ServiceError(409, 'INVALID_CHECKIN_STATE', 'Este agendamento não aceita check-in.')
        }
        const timing = await client.query(
          `SELECT now() < $1::timestamptz - $2::integer * interval '1 minute' AS too_early,
                  now() > $1::timestamptz + $3::integer * interval '1 minute' AS too_late`,
          [appointment.starts_at, appointment.self_checkin_before_minutes,
            appointment.self_checkin_after_minutes],
        )
        if (timing.rows[0].too_early) {
          throw new ServiceError(409, 'CHECKIN_TOO_EARLY', 'O check-in ainda não está disponível.')
        }
        if (timing.rows[0].too_late) {
          throw new ServiceError(409, 'CHECKIN_WINDOW_CLOSED', 'A janela de check-in já encerrou.')
        }
        await client.query(
          `INSERT INTO checkins
            (organization_id, appointment_participant_id, method, recorded_by_membership_id)
           VALUES ($1, $2, 'self', $3)`,
          [organizationId, appointment.participant_id, identity.actor.id],
        )
        await appendAuditEvent(client, {
          organizationId,
          actorMembershipId: identity.actor.id,
          action: 'client.check_in',
          targetType: 'appointment_participant',
          targetId: appointment.participant_id,
          minimalMetadata: { appointmentId, method: 'self' },
        })
        await client.query(
          `INSERT INTO outbox_events
            (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
           VALUES ($1, 'appointment_participant', $2, 'client.checked_in', '{}'::jsonb, $3)`,
          [organizationId, appointment.participant_id,
            `client.checked_in:${appointment.participant_id}`],
        )
      }
      const result = await client.query(
        `${ownAppointmentSelect}
         WHERE participant.organization_id = $1 AND participant.client_id = $2
           AND appointment.id = $3`,
        [organizationId, identity.client.id, appointmentId],
      )
      return mapOwnAppointment(result.rows[0])
    })
  }

  getOwnWaitlist({ actorUserId, organizationId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.read',
      )
      const pendingAppointments = await client.query(
        `SELECT DISTINCT appointment_id FROM waitlist_entries
         WHERE organization_id = $1 AND status IN ('queued', 'offered')`,
        [organizationId],
      )
      for (const row of pendingAppointments.rows) {
        await advanceWaitlistOffer(client, organizationId, row.appointment_id)
      }
      const entries = await client.query(
        `${waitlistEntrySelect}
         WHERE entry.organization_id = $1 AND entry.client_id = $2
           AND entry.status IN ('queued', 'offered')
         ORDER BY appointment.starts_at, entry.queue_position`,
        [organizationId, identity.client.id],
      )
      const eligible = await client.query(
        `SELECT appointment.id, appointment.starts_at, appointment.ends_at,
                appointment.capacity,
                service.id AS service_id, service.name AS service_name,
                professional.id AS professional_id,
                professional.display_name AS professional_name,
                unit.id AS unit_id, unit.name AS unit_name, unit.timezone AS unit_timezone,
                room.id AS room_id, room.name AS room_name,
                (SELECT count(*)::int FROM appointment_participants occupied
                 WHERE occupied.organization_id = appointment.organization_id
                   AND occupied.appointment_id = appointment.id
                   AND occupied.status IN ('booked', 'confirmed', 'attended')) AS occupancy
         FROM appointments appointment
         JOIN services service
           ON service.organization_id = appointment.organization_id
          AND service.id = appointment.service_id
         JOIN professionals professional
           ON professional.organization_id = appointment.organization_id
          AND professional.id = appointment.professional_id
         JOIN units unit
           ON unit.organization_id = appointment.organization_id AND unit.id = appointment.unit_id
         LEFT JOIN rooms room
           ON room.organization_id = appointment.organization_id AND room.id = appointment.room_id
         WHERE appointment.organization_id = $1
           AND appointment.appointment_type = 'class'
           AND appointment.status = 'scheduled'
           AND appointment.starts_at > now()
           AND appointment.starts_at <= now() + interval '90 days'
           AND (SELECT count(*) FROM appointment_participants occupied
                WHERE occupied.organization_id = appointment.organization_id
                  AND occupied.appointment_id = appointment.id
                  AND occupied.status IN ('booked', 'confirmed', 'attended')) >= appointment.capacity
           AND NOT EXISTS (
             SELECT 1 FROM appointment_participants own_participation
             WHERE own_participation.organization_id = appointment.organization_id
               AND own_participation.appointment_id = appointment.id
               AND own_participation.client_id = $2
               AND own_participation.status IN ('booked', 'confirmed', 'attended')
           )
           AND NOT EXISTS (
             SELECT 1 FROM waitlist_entries own_entry
             WHERE own_entry.organization_id = appointment.organization_id
               AND own_entry.appointment_id = appointment.id
               AND own_entry.client_id = $2
               AND own_entry.status IN ('queued', 'offered')
           )
         ORDER BY appointment.starts_at, appointment.id LIMIT 50`,
        [organizationId, identity.client.id],
      )
      return {
        entries: entries.rows.map(mapWaitlistEntry),
        eligibleAppointments: eligible.rows.map((row) => ({
          id: row.id, startsAt: row.starts_at, endsAt: row.ends_at,
          capacity: row.capacity, occupancy: row.occupancy,
          service: { id: row.service_id, name: row.service_name },
          professional: { id: row.professional_id, displayName: row.professional_name },
          unit: { id: row.unit_id, name: row.unit_name, timezone: row.unit_timezone },
          room: row.room_id ? { id: row.room_id, name: row.room_name } : null,
        })),
      }
    })
  }

  joinOwnWaitlist({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.manage',
      )
      const appointment = await client.query(
        `SELECT appointment_type, status, starts_at > clock_timestamp() AS is_future, capacity
         FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) {
        throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      }
      const selected = appointment.rows[0]
      if (selected.appointment_type !== 'class' || selected.status !== 'scheduled'
        || !selected.is_future) {
        throw new ServiceError(409, 'WAITLIST_UNAVAILABLE', 'Esta turma não aceita novos interesses.')
      }
      const existing = await client.query(
        `SELECT id FROM waitlist_entries
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('queued', 'offered')`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (existing.rowCount) {
        return selectWaitlistEntry(client, organizationId, existing.rows[0].id)
      }
      const participant = await client.query(
        `SELECT id FROM appointment_participants
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('booked', 'confirmed', 'attended')`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (participant.rowCount) {
        throw new ServiceError(409, 'WAITLIST_ALREADY_PARTICIPANT', 'Você já participa desta turma.')
      }
      const occupancy = await client.query(
        `SELECT count(*)::int AS count FROM appointment_participants
         WHERE organization_id = $1 AND appointment_id = $2
           AND status IN ('booked', 'confirmed', 'attended')`,
        [organizationId, appointmentId],
      )
      if (occupancy.rows[0].count < selected.capacity) {
        throw new ServiceError(409, 'WAITLIST_NOT_REQUIRED', 'Esta turma ainda possui vaga disponível.')
      }
      const inserted = await client.query(
        `INSERT INTO waitlist_entries
          (organization_id, appointment_id, client_id, queue_position)
         SELECT $1, $2, $3, COALESCE(max(queue_position), 0) + 1
         FROM waitlist_entries
         WHERE organization_id = $1 AND appointment_id = $2
         RETURNING id`,
        [organizationId, appointmentId, identity.client.id],
      )
      const entryId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: identity.actor.id,
        action: 'waitlist.interest_created', targetType: 'waitlist_entry', targetId: entryId,
        minimalMetadata: { appointmentId },
      })
      await appendWaitlistOutbox(client, {
        organizationId, aggregateType: 'waitlist_entry', aggregateId: entryId,
        eventType: 'waitlist.interest.created', safePayload: { appointmentId },
        idempotencyKey: `waitlist.interest.created:${entryId}`,
      })
      return selectWaitlistEntry(client, organizationId, entryId)
    })
  }

  leaveOwnWaitlist({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.manage',
      )
      const appointment = await client.query(
        `SELECT id FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) {
        throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      }
      const entry = await client.query(
        `SELECT id FROM waitlist_entries
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('queued', 'offered') FOR UPDATE`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (!entry.rowCount) {
        throw new ServiceError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'Interesse ativo não encontrado.')
      }
      const entryId = entry.rows[0].id
      await client.query(
        `UPDATE waitlist_offers SET status = 'cancelled'
         WHERE organization_id = $1 AND waitlist_entry_id = $2 AND status = 'active'`,
        [organizationId, entryId],
      )
      await client.query(
        `UPDATE waitlist_entries SET status = 'cancelled'
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, entryId],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: identity.actor.id,
        action: 'waitlist.interest_cancelled', targetType: 'waitlist_entry', targetId: entryId,
        minimalMetadata: { appointmentId },
      })
      await appendWaitlistOutbox(client, {
        organizationId, aggregateType: 'waitlist_entry', aggregateId: entryId,
        eventType: 'waitlist.interest.cancelled', safePayload: { appointmentId },
        idempotencyKey: `waitlist.interest.cancelled:${entryId}`,
      })
      await advanceWaitlistOffer(client, organizationId, appointmentId)
      return { id: entryId, status: 'cancelled' }
    })
  }

  confirmOwnWaitlistOffer({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const identity = await this.#requireClientIdentity(
        client, actorUserId, organizationId, 'schedule.own.manage',
      )

      await advanceWaitlistOffer(client, organizationId, appointmentId)
      const appointment = await client.query(
        `SELECT appointment.appointment_type, appointment.status,
                appointment.starts_at > clock_timestamp() AS is_future,
                (appointment.starts_at AT TIME ZONE unit.timezone)::date AS appointment_date
         FROM appointments appointment
         JOIN units unit
           ON unit.organization_id = appointment.organization_id
          AND unit.id = appointment.unit_id
         WHERE appointment.organization_id = $1 AND appointment.id = $2`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) {
        throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      }

      const active = await client.query(
        `SELECT offer.id AS offer_id, entry.id AS entry_id
         FROM waitlist_offers offer
         JOIN waitlist_entries entry
           ON entry.organization_id = offer.organization_id
          AND entry.id = offer.waitlist_entry_id
         WHERE offer.organization_id = $1 AND offer.appointment_id = $2
           AND entry.client_id = $3 AND entry.status = 'offered'
           AND offer.status = 'active' AND offer.expires_at > clock_timestamp()
         FOR UPDATE OF offer, entry`,
        [organizationId, appointmentId, identity.client.id],
      )
      const consumed = await client.query(
        `SELECT offer.consumed_by_participant_id AS participant_id
         FROM waitlist_offers offer
         JOIN waitlist_entries entry
           ON entry.organization_id = offer.organization_id
          AND entry.id = offer.waitlist_entry_id
         WHERE offer.organization_id = $1 AND offer.appointment_id = $2
           AND entry.client_id = $3 AND offer.status = 'consumed'
         ORDER BY offer.consumed_at DESC, offer.id DESC LIMIT 1`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (!active.rowCount && consumed.rowCount) {
        const existing = await client.query(
          `${ownAppointmentSelect}
           WHERE participant.organization_id = $1 AND participant.client_id = $2
             AND participant.id = $3`,
          [organizationId, identity.client.id, consumed.rows[0].participant_id],
        )
        if (existing.rowCount) return mapOwnAppointment(existing.rows[0])
      }

      const selectedAppointment = appointment.rows[0]
      if (selectedAppointment.appointment_type !== 'class'
        || selectedAppointment.status !== 'scheduled' || !selectedAppointment.is_future) {
        throw new ServiceError(
          409, 'WAITLIST_OFFER_UNAVAILABLE', 'Esta oferta não pode mais ser confirmada.',
        )
      }

      if (!active.rowCount) {
        const previous = await client.query(
          `SELECT offer.status
           FROM waitlist_offers offer
           JOIN waitlist_entries entry
             ON entry.organization_id = offer.organization_id
            AND entry.id = offer.waitlist_entry_id
           WHERE offer.organization_id = $1 AND offer.appointment_id = $2
             AND entry.client_id = $3
           ORDER BY offer.offered_at DESC, offer.id DESC LIMIT 1`,
          [organizationId, appointmentId, identity.client.id],
        )
        if (previous.rows[0]?.status === 'expired') {
          throw new ServiceError(
            409, 'WAITLIST_OFFER_EXPIRED', 'O prazo desta oferta encerrou e a fila avançou.',
          )
        }
        throw new ServiceError(
          409, 'WAITLIST_OFFER_NOT_ACTIVE', 'Não existe uma oferta ativa para esta conta.',
        )
      }

      const existingParticipant = await client.query(
        `SELECT id FROM appointment_participants
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('booked', 'confirmed', 'attended')`,
        [organizationId, appointmentId, identity.client.id],
      )
      if (existingParticipant.rowCount) {
        throw new ServiceError(409, 'WAITLIST_ALREADY_PARTICIPANT', 'Você já participa desta turma.')
      }

      const contract = await client.query(
        `SELECT contract.id
         FROM contracts contract
         JOIN plans plan
           ON plan.organization_id = contract.organization_id
          AND plan.id = contract.plan_id
         WHERE contract.organization_id = $1 AND contract.client_id = $2
           AND contract.status = 'active' AND plan.active
           AND contract.starts_on <= $3::date
           AND (contract.ends_on IS NULL OR contract.ends_on >= $3::date)
         ORDER BY contract.starts_on DESC, contract.id
         LIMIT 1 FOR UPDATE OF contract`,
        [organizationId, identity.client.id, selectedAppointment.appointment_date],
      )

      const inserted = await client.query(
        `INSERT INTO appointment_participants
          (organization_id, appointment_id, client_id, status)
         VALUES ($1, $2, $3, 'confirmed')
         RETURNING id`,
        [organizationId, appointmentId, identity.client.id],
      )
      const participantId = inserted.rows[0].id
      if (!contract.rowCount) {
        const creditId = await consumeReplacementCredit(client, {
          organizationId, clientId: identity.client.id, participantId,
          appointmentDate: selectedAppointment.appointment_date,
        })
        if (!creditId) {
          throw new ServiceError(
            409, 'WAITLIST_COVERAGE_REQUIRED',
            'Seu plano ou crédito de reposição não cobre esta turma.',
          )
        }
        await recordReplacementCreditConsumption(client, {
          organizationId, actorMembershipId: identity.actor.id,
          creditId, participantId, appointmentId,
        })
      }

      const offerId = active.rows[0].offer_id
      const entryId = active.rows[0].entry_id
      await client.query(
        `UPDATE waitlist_entries SET status = 'consumed'
         WHERE organization_id = $1 AND id = $2 AND status = 'offered'`,
        [organizationId, entryId],
      )
      const offer = await client.query(
        `UPDATE waitlist_offers
         SET status = 'consumed', consumed_at = clock_timestamp(),
             consumed_by_participant_id = $3
         WHERE organization_id = $1 AND id = $2
           AND status = 'active' AND expires_at > clock_timestamp()
         RETURNING id`,
        [organizationId, offerId, participantId],
      )
      if (!offer.rowCount) {
        throw new ServiceError(
          409, 'WAITLIST_OFFER_EXPIRED', 'O prazo desta oferta encerrou e a fila avançou.',
        )
      }

      await appendAuditEvent(client, {
        organizationId, actorMembershipId: identity.actor.id,
        action: 'waitlist.offer_consumed', targetType: 'waitlist_offer', targetId: offerId,
        minimalMetadata: { appointmentId, waitlistEntryId: entryId, participantId },
      })
      await appendWaitlistOutbox(client, {
        organizationId, aggregateType: 'waitlist_offer', aggregateId: offerId,
        eventType: 'waitlist.offer.consumed', safePayload: { appointmentId },
        idempotencyKey: `waitlist.offer.consumed:${offerId}`,
      })

      const confirmed = await client.query(
        `${ownAppointmentSelect}
         WHERE participant.organization_id = $1 AND participant.client_id = $2
           AND participant.id = $3`,
        [organizationId, identity.client.id, participantId],
      )
      return mapOwnAppointment(confirmed.rows[0])
    })
  }

  advanceWaitlistOffer({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(
        client, actorUserId, organizationId, 'schedule.manage',
      )
      const appointment = await client.query(
        `SELECT professional_id FROM appointments
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) return null
      this.#requireProfessionalScope(actor, appointment.rows[0].professional_id)
      const offer = await advanceWaitlistOffer(client, organizationId, appointmentId)
      return offer ? {
        id: offer.id, waitlistEntryId: offer.waitlist_entry_id,
        offeredAt: offer.offered_at, expiresAt: offer.expires_at,
      } : null
    })
  }

  getClient({ actorUserId, organizationId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'clients.read')
      return selectClient(client, organizationId, clientId)
    })
  }

  createClient({ actorUserId, organizationId, client: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'clients.manage')
      const result = await client.query(
        `INSERT INTO clients
          (organization_id, full_name, birth_date, document_number, document_normalized, client_type)
         VALUES ($1, $2, $3, $4, $4, $5)
         RETURNING id`,
        [organizationId, input.fullName, input.birthDate, input.documentNumber, input.clientType ?? 'rotating'],
      )
      const clientId = result.rows[0].id
      await insertClientContacts(client, organizationId, clientId, input.contacts)
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'client.created',
        targetType: 'client',
        targetId: clientId,
        minimalMetadata: {
          clientType: input.clientType ?? 'rotating',
          contactTypes: [...new Set(input.contacts.map(({ type }) => type))],
        },
      })
      return selectClient(client, organizationId, clientId)
    })
  }

  updateClient({ actorUserId, organizationId, clientId, client: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'clients.manage')
      const existing = await client.query(
        `SELECT id, client_type FROM clients
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [organizationId, clientId],
      )
      if (!existing.rowCount) return null
      await client.query(
        `UPDATE clients SET full_name = $3, birth_date = $4,
           document_number = $5, document_normalized = $5, client_type = $6
         WHERE organization_id = $1 AND id = $2`,
        [
          organizationId, clientId, input.fullName, input.birthDate, input.documentNumber,
          input.clientType ?? 'rotating',
        ],
      )
      await client.query(
        'DELETE FROM client_contacts WHERE organization_id = $1 AND client_id = $2',
        [organizationId, clientId],
      )
      await insertClientContacts(client, organizationId, clientId, input.contacts)
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'client.updated',
        targetType: 'client',
        targetId: clientId,
        minimalMetadata: {
          clientType: input.clientType ?? 'rotating',
          previousClientType: existing.rows[0].client_type,
          contactTypes: [...new Set(input.contacts.map(({ type }) => type))],
        },
      })
      return selectClient(client, organizationId, clientId)
    })
  }

  archiveClient({ actorUserId, organizationId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'clients.manage')
      const result = await client.query(
        `UPDATE clients SET status = 'archived', deleted_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [organizationId, clientId],
      )
      if (!result.rowCount) return false
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'client.archived',
        targetType: 'client',
        targetId: clientId,
        minimalMetadata: { status: 'archived' },
      })
      return true
    })
  }

  listReceivables({
    actorUserId, organizationId, status = null, search = null,
    dueFrom = null, dueTo = null, page = 1, pageSize = 20,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'finance.read')
      const searchPattern = search ? `%${search.toLocaleLowerCase('pt-BR')}%` : null
      const filteredSql = `WITH listed AS (${receivableSelect}
        WHERE receivable.organization_id = $1)
        SELECT * FROM listed
        WHERE ($2::text IS NULL OR effective_status = $2)
          AND ($3::text IS NULL OR lower(description) LIKE $3 OR lower(client_name) LIKE $3)
          AND ($4::date IS NULL OR due_on >= $4)
          AND ($5::date IS NULL OR due_on <= $5)`
      const parameters = [organizationId, status, searchPattern, dueFrom, dueTo]
      const totalResult = await client.query(
        `SELECT count(*)::int AS total FROM (${filteredSql}) filtered`, parameters,
      )
      const result = await client.query(
        `${filteredSql} ORDER BY due_on DESC, id DESC LIMIT $6 OFFSET $7`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      const summary = await client.query(
        `WITH listed AS (${receivableSelect} WHERE receivable.organization_id = $1)
         SELECT count(*) FILTER (WHERE effective_status IN ('open', 'partially_paid', 'overdue'))::int AS count,
                COALESCE(sum(balance_cents) FILTER (WHERE effective_status IN ('open', 'partially_paid', 'overdue')), 0)::bigint AS open_balance_cents,
                COALESCE(sum(balance_cents) FILTER (WHERE effective_status = 'overdue'), 0)::bigint AS overdue_balance_cents
         FROM listed`,
        [organizationId],
      )
      const clients = await client.query(
        `SELECT id, full_name FROM clients
         WHERE organization_id = $1 AND status = 'active' AND deleted_at IS NULL
         ORDER BY full_name, id`,
        [organizationId],
      )
      const categories = await client.query(
        `SELECT id, name FROM financial_categories
         WHERE organization_id = $1 AND active AND kind IN ('receivable', 'both')
         ORDER BY name, id`,
        [organizationId],
      )
      return {
        items: result.rows.map(mapReceivable),
        summary: {
          count: summary.rows[0].count,
          openBalanceCents: Number(summary.rows[0].open_balance_cents),
          overdueBalanceCents: Number(summary.rows[0].overdue_balance_cents),
        },
        options: {
          clients: clients.rows.map((row) => ({ id: row.id, name: row.full_name })),
          categories: categories.rows.map((row) => ({ id: row.id, name: row.name })),
        },
        pagination: {
          page, pageSize, total: totalResult.rows[0].total,
          totalPages: Math.ceil(totalResult.rows[0].total / pageSize),
        },
      }
    })
  }

  getReceivable({ actorUserId, organizationId, receivableId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'finance.read')
      const record = await selectReceivable(client, organizationId, receivableId)
      if (!record) return null
      const [payments, history] = await Promise.all([
        client.query(
          `SELECT payment.*, reversal.id AS reversal_id FROM payments payment
           LEFT JOIN payments reversal
             ON reversal.organization_id = payment.organization_id
            AND reversal.reverses_payment_id = payment.id
           WHERE payment.organization_id = $1 AND payment.receivable_id = $2
           ORDER BY payment.paid_at DESC, payment.id DESC`,
          [organizationId, receivableId],
        ),
        client.query(
          `SELECT id, action, minimal_metadata, occurred_at
           FROM audit_events
           WHERE organization_id = $1 AND target_type = 'receivable' AND target_id = $2
           ORDER BY occurred_at DESC, id DESC`,
          [organizationId, receivableId],
        ),
      ])
      return {
        ...record,
        payments: payments.rows.map(mapFinancialPayment),
        history: history.rows.map((row) => ({
          id: row.id, action: row.action,
          minimalMetadata: row.minimal_metadata, occurredAt: row.occurred_at,
        })),
      }
    })
  }

  createReceivable({ actorUserId, organizationId, receivable: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT id, recurrence_id FROM receivables
         WHERE organization_id = $1 AND idempotency_key = $2
         UNION ALL
         SELECT receivable.id, receivable.recurrence_id FROM receivable_recurrences recurrence
         JOIN receivables receivable
           ON receivable.organization_id = recurrence.organization_id
          AND receivable.recurrence_id = recurrence.id
         WHERE recurrence.organization_id = $1 AND recurrence.idempotency_key = $2
         ORDER BY id`,
        [organizationId, input.idempotencyKey],
      )
      if (existing.rowCount) {
        const records = []
        for (const row of existing.rows) {
          records.push(await selectReceivable(client, organizationId, row.id))
        }
        return { items: records, replayed: true }
      }
      const references = await client.query(
        `SELECT
          EXISTS (SELECT 1 FROM clients WHERE organization_id = $1 AND id = $2
            AND status = 'active' AND deleted_at IS NULL) AS client_exists,
          EXISTS (SELECT 1 FROM financial_categories WHERE organization_id = $1 AND id = $3
            AND active AND kind IN ('receivable', 'both')) AS category_exists`,
        [organizationId, input.clientId, input.categoryId],
      )
      if (!references.rows[0].client_exists || !references.rows[0].category_exists) {
        throw new ServiceError(400, 'INVALID_RECEIVABLE_REFERENCE', 'Cliente ou categoria indisponível.')
      }

      const count = input.recurrence?.installmentCount ?? 1
      const recurrenceId = input.recurrence ? randomUUID() : null
      if (recurrenceId) {
        const insertedRecurrence = await client.query(
          `INSERT INTO receivable_recurrences
            (id, organization_id, idempotency_key, frequency, installment_count)
           VALUES ($1, $2, $3, 'monthly', $4)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [recurrenceId, organizationId, input.idempotencyKey, count],
        )
        if (!insertedRecurrence.rowCount) {
          const replay = await client.query(
            `SELECT receivable.id FROM receivable_recurrences recurrence
             JOIN receivables receivable
               ON receivable.organization_id = recurrence.organization_id
              AND receivable.recurrence_id = recurrence.id
             WHERE recurrence.organization_id = $1 AND recurrence.idempotency_key = $2
             ORDER BY receivable.installment_number`,
            [organizationId, input.idempotencyKey],
          )
          const replayedItems = []
          for (const row of replay.rows) {
            replayedItems.push(await selectReceivable(client, organizationId, row.id))
          }
          return { items: replayedItems, replayed: true }
        }
      }
      const records = []
      for (let index = 0; index < count; index += 1) {
        const dueOn = addMonthsClamped(input.dueOn, index)
        const competenceOn = addMonthsClamped(input.competenceOn, index).slice(0, 7) + '-01'
        const key = count === 1 ? input.idempotencyKey : `${input.idempotencyKey}:${index + 1}`
        const result = await client.query(
          `INSERT INTO receivables
            (organization_id, client_id, category_id, description, original_amount_cents,
             currency, competence_on, due_on, status, idempotency_key,
             recurrence_id, installment_number)
           VALUES ($1, $2, $3, $4, $5, 'BRL', $6, $7, 'open', $8, $9, $10)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            organizationId, input.clientId, input.categoryId, input.description,
            input.amountCents, competenceOn, dueOn, key, recurrenceId,
            recurrenceId ? index + 1 : null,
          ],
        )
        if (!result.rowCount) {
          const replay = await client.query(
            `SELECT id FROM receivables WHERE organization_id = $1 AND idempotency_key = $2`,
            [organizationId, key],
          )
          return {
            items: [await selectReceivable(client, organizationId, replay.rows[0].id)],
            replayed: true,
          }
        }
        const id = result.rows[0].id
        await appendAuditEvent(client, {
          organizationId, actorMembershipId: actor.id,
          action: 'receivable.created', targetType: 'receivable', targetId: id,
          minimalMetadata: {
            recurring: Boolean(recurrenceId),
            ...(recurrenceId ? { installmentNumber: index + 1, installmentCount: count } : {}),
          },
        })
        records.push(await selectReceivable(client, organizationId, id))
      }
      return { items: records, replayed: false }
    })
  }

  generateContractReceivables({ actorUserId, organizationId, generation: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existingRun = await client.query(
        `SELECT id, contract_id, category_id, competence_on
         FROM receivable_generation_runs
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, input.idempotencyKey],
      )
      if (existingRun.rowCount) {
        const run = existingRun.rows[0]
        if (run.contract_id !== input.contractId || run.category_id !== input.categoryId
          || mapDateOnly(run.competence_on) !== input.competenceOn) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        const replay = await client.query(
          `SELECT receivable.id FROM receivables receivable
           WHERE receivable.organization_id = $1
             AND receivable.competence_on = $2
             AND ($3::uuid IS NULL OR receivable.contract_id = $3)
           ORDER BY receivable.contract_id, receivable.id`,
          [organizationId, input.competenceOn, input.contractId],
        )
        const items = []
        for (const row of replay.rows) items.push(await selectReceivable(client, organizationId, row.id))
        return { items, generatedCount: 0, replayed: true }
      }

      const category = await client.query(
        `SELECT id FROM financial_categories
         WHERE organization_id = $1 AND id = $2 AND active AND kind IN ('receivable', 'both')`,
        [organizationId, input.categoryId],
      )
      if (!category.rowCount) {
        throw new ServiceError(400, 'INVALID_BILLING_REFERENCE', 'Categoria financeira indisponível.')
      }
      const runId = randomUUID()
      await client.query(
        `INSERT INTO receivable_generation_runs
          (id, organization_id, contract_id, category_id, competence_on, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, organizationId, input.contractId, input.categoryId,
          input.competenceOn, input.idempotencyKey],
      )
      const contracts = await client.query(
        `SELECT contract.id, contract.client_id, contract.agreed_price_cents,
                plan.name AS plan_name, plan.billing_rule
         FROM contracts contract
         JOIN plans plan
           ON plan.organization_id = contract.organization_id AND plan.id = contract.plan_id
         JOIN clients billed_client
           ON billed_client.organization_id = contract.organization_id
          AND billed_client.id = contract.client_id
         WHERE contract.organization_id = $1
           AND contract.status = 'active' AND plan.active
           AND billed_client.status = 'active' AND billed_client.deleted_at IS NULL
           AND contract.agreed_price_cents > 0
           AND contract.starts_on <= ($2::date + interval '1 month - 1 day')::date
           AND (contract.ends_on IS NULL OR contract.ends_on >= $2::date)
           AND ($3::uuid IS NULL OR contract.id = $3)
         ORDER BY contract.id
         FOR UPDATE OF contract`,
        [organizationId, input.competenceOn, input.contractId],
      )
      if (input.contractId && !contracts.rowCount) {
        throw new ServiceError(400, 'INVALID_BILLING_REFERENCE', 'Contrato ativo indisponível para a competência.')
      }

      const items = []
      let generatedCount = 0
      for (const contract of contracts.rows) {
        const configuredDueDay = Number(contract.billing_rule?.dueDay ?? 10)
        const dueDay = Number.isInteger(configuredDueDay) && configuredDueDay >= 1 && configuredDueDay <= 31
          ? configuredDueDay : 10
        const dueOn = addMonthsClamped(
          `${input.competenceOn.slice(0, 8)}${String(dueDay).padStart(2, '0')}`,
          0,
        )
        const inserted = await client.query(
          `INSERT INTO receivables
            (organization_id, client_id, contract_id, category_id, description,
             original_amount_cents, currency, competence_on, due_on, status,
             idempotency_key, generation_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'BRL', $7, $8, 'open', $9, $10)
           ON CONFLICT (organization_id, contract_id, competence_on)
             WHERE contract_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            organizationId, contract.client_id, contract.id, input.categoryId,
            `${contract.plan_name} · ${input.competenceOn.slice(5, 7)}/${input.competenceOn.slice(0, 4)}`,
            contract.agreed_price_cents, input.competenceOn, dueOn,
            `contract:${contract.id}:${input.competenceOn.slice(0, 7)}`, runId,
          ],
        )
        let receivableId
        if (inserted.rowCount) {
          generatedCount += 1
          receivableId = inserted.rows[0].id
          await appendAuditEvent(client, {
            organizationId, actorMembershipId: actor.id,
            action: 'receivable.generated', targetType: 'receivable', targetId: receivableId,
            minimalMetadata: { contractId: contract.id, competenceOn: input.competenceOn },
          })
        } else {
          const existing = await client.query(
            `SELECT id FROM receivables
             WHERE organization_id = $1 AND contract_id = $2 AND competence_on = $3`,
            [organizationId, contract.id, input.competenceOn],
          )
          receivableId = existing.rows[0].id
        }
        items.push(await selectReceivable(client, organizationId, receivableId))
      }
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'receivable.generation.completed', targetType: 'receivable_generation_run',
        targetId: runId,
        minimalMetadata: {
          competenceOn: input.competenceOn, generatedCount,
          contractScoped: input.contractId !== null,
        },
      })
      return { items, generatedCount, replayed: false }
    })
  }

  updateReceivable({ actorUserId, organizationId, receivableId, receivable: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT receivable.id, receivable.status,
                (SELECT count(*)::int FROM payments payment
                 WHERE payment.organization_id = receivable.organization_id
                   AND payment.receivable_id = receivable.id
                   AND payment.reverses_payment_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM payments reversal
                     WHERE reversal.organization_id = payment.organization_id
                       AND reversal.reverses_payment_id = payment.id
                   )) AS payment_count
         FROM receivables receivable
         WHERE receivable.organization_id = $1 AND receivable.id = $2
         FOR UPDATE`,
        [organizationId, receivableId],
      )
      if (!existing.rowCount) return null
      if (existing.rows[0].status === 'cancelled' || existing.rows[0].payment_count > 0) {
        throw new ServiceError(409, 'RECEIVABLE_IMMUTABLE', 'A conta cancelada ou com lançamentos não pode ser editada.')
      }
      const references = await client.query(
        `SELECT
          EXISTS (SELECT 1 FROM clients WHERE organization_id = $1 AND id = $2
            AND status = 'active' AND deleted_at IS NULL) AS client_exists,
          EXISTS (SELECT 1 FROM financial_categories WHERE organization_id = $1 AND id = $3
            AND active AND kind IN ('receivable', 'both')) AS category_exists`,
        [organizationId, input.clientId, input.categoryId],
      )
      if (!references.rows[0].client_exists || !references.rows[0].category_exists) {
        throw new ServiceError(400, 'INVALID_RECEIVABLE_REFERENCE', 'Cliente ou categoria indisponível.')
      }
      await client.query(
        `UPDATE receivables SET client_id = $3, category_id = $4, description = $5,
           original_amount_cents = $6, competence_on = $7, due_on = $8
         WHERE organization_id = $1 AND id = $2`,
        [
          organizationId, receivableId, input.clientId, input.categoryId,
          input.description, input.amountCents, input.competenceOn, input.dueOn,
        ],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'receivable.updated', targetType: 'receivable', targetId: receivableId,
        minimalMetadata: { fields: ['client', 'category', 'description', 'amount', 'competence', 'dueOn'] },
      })
      return selectReceivable(client, organizationId, receivableId)
    })
  }

  cancelReceivable({ actorUserId, organizationId, receivableId, reason }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT receivable.status,
                (SELECT count(*)::int FROM payments payment
                 WHERE payment.organization_id = receivable.organization_id
                   AND payment.receivable_id = receivable.id
                   AND payment.reverses_payment_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM payments reversal
                     WHERE reversal.organization_id = payment.organization_id
                       AND reversal.reverses_payment_id = payment.id
                   )) AS payment_count
         FROM receivables receivable
         WHERE receivable.organization_id = $1 AND receivable.id = $2
         FOR UPDATE`,
        [organizationId, receivableId],
      )
      if (!existing.rowCount) return null
      if (existing.rows[0].status === 'cancelled') {
        return selectReceivable(client, organizationId, receivableId)
      }
      if (existing.rows[0].payment_count > 0) {
        throw new ServiceError(409, 'RECEIVABLE_HAS_PAYMENTS', 'Estorne os lançamentos antes de cancelar esta conta.')
      }
      await client.query(
        `UPDATE receivables SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $3
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, receivableId, reason],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'receivable.cancelled', targetType: 'receivable', targetId: receivableId,
        minimalMetadata: { reasonProvided: true },
      })
      return selectReceivable(client, organizationId, receivableId)
    })
  }

  createReceivablePayment({ actorUserId, organizationId, receivableId, payment: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const replay = await client.query(
        `SELECT id, receivable_id FROM payments WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, input.idempotencyKey],
      )
      if (replay.rowCount) {
        if (replay.rows[0].receivable_id !== receivableId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectReceivablePayment(client, organizationId, replay.rows[0].id), replayed: true }
      }
      const account = await client.query(
        `SELECT receivable.status, balance.balance_cents
         FROM receivables receivable
         JOIN receivable_balances balance
           ON balance.organization_id = receivable.organization_id
          AND balance.receivable_id = receivable.id
         WHERE receivable.organization_id = $1 AND receivable.id = $2
         FOR UPDATE OF receivable`,
        [organizationId, receivableId],
      )
      if (!account.rowCount) return null
      if (account.rows[0].status === 'cancelled') {
        throw new ServiceError(409, 'RECEIVABLE_CANCELLED', 'Uma conta cancelada não pode receber pagamentos.')
      }
      if (input.amountCents > Number(account.rows[0].balance_cents)) {
        throw new ServiceError(409, 'PAYMENT_EXCEEDS_BALANCE', 'O recebimento não pode superar o saldo da conta.')
      }
      const inserted = await client.query(
        `INSERT INTO payments
          (organization_id, receivable_id, amount_cents, method, external_reference, paid_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          organizationId, receivableId, input.amountCents, input.method,
          input.externalReference, input.paidAt, input.idempotencyKey,
        ],
      )
      if (!inserted.rowCount) {
        const concurrent = await client.query(
          `SELECT id, receivable_id FROM payments WHERE organization_id = $1 AND idempotency_key = $2`,
          [organizationId, input.idempotencyKey],
        )
        if (!concurrent.rowCount || concurrent.rows[0].receivable_id !== receivableId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectReceivablePayment(client, organizationId, concurrent.rows[0].id), replayed: true }
      }
      const paymentId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'receivable.payment.recorded', targetType: 'receivable', targetId: receivableId,
        minimalMetadata: { paymentId, method: input.method },
      })
      return { payment: await selectReceivablePayment(client, organizationId, paymentId), replayed: false }
    })
  }

  createReceivablePayments({ actorUserId, organizationId, receivableId, payments: items }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const account = await client.query(
        `SELECT receivable.status, balance.balance_cents
         FROM receivables receivable
         JOIN receivable_balances balance
           ON balance.organization_id = receivable.organization_id
          AND balance.receivable_id = receivable.id
         WHERE receivable.organization_id = $1 AND receivable.id = $2
         FOR UPDATE OF receivable`,
        [organizationId, receivableId],
      )
      if (!account.rowCount) return null
      if (account.rows[0].status === 'cancelled') {
        throw new ServiceError(409, 'RECEIVABLE_CANCELLED', 'Uma conta cancelada não pode receber pagamentos.')
      }
      const totalAmount = items.reduce((sum, item) => sum + item.amountCents, 0)
      if (totalAmount > Number(account.rows[0].balance_cents)) {
        throw new ServiceError(409, 'PAYMENT_EXCEEDS_BALANCE', 'O recebimento não pode superar o saldo da conta.')
      }
      const createdPayments = []
      let anyReplayed = false
      for (const input of items) {
        const replay = await client.query(
          `SELECT id, receivable_id FROM payments WHERE organization_id = $1 AND idempotency_key = $2`,
          [organizationId, input.idempotencyKey],
        )
        if (replay.rowCount) {
          if (replay.rows[0].receivable_id !== receivableId) {
            throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
          }
          anyReplayed = true
          createdPayments.push(await selectReceivablePayment(client, organizationId, replay.rows[0].id))
          continue
        }
        const inserted = await client.query(
          `INSERT INTO payments
            (organization_id, receivable_id, amount_cents, method, external_reference, paid_at, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            organizationId, receivableId, input.amountCents, input.method,
            input.externalReference, input.paidAt, input.idempotencyKey,
          ],
        )
        const paymentId = inserted.rowCount
          ? inserted.rows[0].id
          : (await client.query(
              `SELECT id FROM payments WHERE organization_id = $1 AND idempotency_key = $2`,
              [organizationId, input.idempotencyKey],
            )).rows[0].id

        await appendAuditEvent(client, {
          organizationId, actorMembershipId: actor.id,
          action: 'receivable.payment.recorded', targetType: 'receivable', targetId: receivableId,
          minimalMetadata: { paymentId, method: input.method },
        })
        createdPayments.push(await selectReceivablePayment(client, organizationId, paymentId))
      }
      return { payments: createdPayments, replayed: anyReplayed }
    })
  }

  reverseReceivablePayment({ actorUserId, organizationId, receivableId, paymentId, reversal: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const replay = await client.query(
        `SELECT id, receivable_id, reverses_payment_id FROM payments
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, input.idempotencyKey],
      )
      if (replay.rowCount) {
        if (replay.rows[0].receivable_id !== receivableId || replay.rows[0].reverses_payment_id !== paymentId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectReceivablePayment(client, organizationId, replay.rows[0].id), replayed: true }
      }
      const original = await client.query(
        `SELECT payment.amount_cents, payment.method, payment.paid_at,
                reversal.id AS reversal_id, receivable.status
         FROM payments payment
         JOIN receivables receivable
           ON receivable.organization_id = payment.organization_id
          AND receivable.id = payment.receivable_id
         LEFT JOIN payments reversal
           ON reversal.organization_id = payment.organization_id
          AND reversal.reverses_payment_id = payment.id
         WHERE payment.organization_id = $1 AND payment.receivable_id = $2
           AND payment.id = $3 AND payment.reverses_payment_id IS NULL
         FOR UPDATE OF payment, receivable`,
        [organizationId, receivableId, paymentId],
      )
      if (!original.rowCount) return null
      if (original.rows[0].reversal_id) {
        throw new ServiceError(409, 'PAYMENT_ALREADY_REVERSED', 'Este recebimento já foi estornado.')
      }
      const inserted = await client.query(
        `INSERT INTO payments
          (organization_id, receivable_id, reverses_payment_id, amount_cents, method,
           paid_at, idempotency_key, reversal_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          organizationId, receivableId, paymentId, -Number(original.rows[0].amount_cents),
          original.rows[0].method, input.reversedAt, input.idempotencyKey, input.reason,
        ],
      )
      const reversalId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'receivable.payment.reversed', targetType: 'receivable', targetId: receivableId,
        minimalMetadata: { paymentId, reversalId, reasonProvided: true },
      })
      return { payment: await selectReceivablePayment(client, organizationId, reversalId), replayed: false }
    })
  }

  createFinancialCategory({ actorUserId, organizationId, category: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const result = await client.query(
        `INSERT INTO financial_categories (organization_id, kind, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, kind, name) DO UPDATE SET active = true
         RETURNING id, kind, name, active`,
        [organizationId, input.kind, input.name],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'financial_category.saved', targetType: 'financial_category', targetId: result.rows[0].id,
        minimalMetadata: { kind: input.kind },
      })
      return result.rows[0]
    })
  }

  listPayables({
    actorUserId, organizationId, status = null, search = null,
    dueFrom = null, dueTo = null, page = 1, pageSize = 20,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'finance.read')
      const searchPattern = search ? `%${search.toLocaleLowerCase('pt-BR')}%` : null
      const filteredSql = `WITH listed AS (${payableSelect} WHERE payable.organization_id = $1)
        SELECT * FROM listed
        WHERE ($2::text IS NULL OR effective_status = $2)
          AND ($3::text IS NULL OR lower(description) LIKE $3 OR lower(counterparty) LIKE $3)
          AND ($4::date IS NULL OR due_on >= $4)
          AND ($5::date IS NULL OR due_on <= $5)`
      const parameters = [organizationId, status, searchPattern, dueFrom, dueTo]
      const total = await client.query(
        `SELECT count(*)::int AS total FROM (${filteredSql}) filtered`, parameters,
      )
      const result = await client.query(
        `${filteredSql} ORDER BY due_on DESC, id DESC LIMIT $6 OFFSET $7`,
        [...parameters, pageSize, (page - 1) * pageSize],
      )
      const summary = await client.query(
        `WITH listed AS (${payableSelect} WHERE payable.organization_id = $1)
         SELECT count(*) FILTER (WHERE effective_status IN ('open', 'partially_paid', 'overdue'))::int AS count,
           COALESCE(sum(balance_cents) FILTER (WHERE effective_status IN ('open', 'partially_paid', 'overdue')), 0)::bigint AS open_balance_cents,
           COALESCE(sum(balance_cents) FILTER (WHERE effective_status = 'overdue'), 0)::bigint AS overdue_balance_cents
         FROM listed`,
        [organizationId],
      )
      const categories = await client.query(
        `SELECT id, name FROM financial_categories
         WHERE organization_id = $1 AND active AND kind IN ('payable', 'both')
         ORDER BY name, id`,
        [organizationId],
      )
      return {
        items: result.rows.map(mapPayable),
        summary: {
          count: summary.rows[0].count,
          openBalanceCents: Number(summary.rows[0].open_balance_cents),
          overdueBalanceCents: Number(summary.rows[0].overdue_balance_cents),
        },
        options: { categories: categories.rows.map((row) => ({ id: row.id, name: row.name })) },
        pagination: {
          page, pageSize, total: total.rows[0].total,
          totalPages: Math.ceil(total.rows[0].total / pageSize),
        },
      }
    })
  }

  getPayable({ actorUserId, organizationId, payableId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'finance.read')
      const record = await selectPayable(client, organizationId, payableId)
      if (!record) return null
      const [payments, history] = await Promise.all([
        client.query(
          `SELECT payment.*, reversal.id AS reversal_id FROM payable_payments payment
           LEFT JOIN payable_payments reversal
             ON reversal.organization_id = payment.organization_id
            AND reversal.reverses_payment_id = payment.id
           WHERE payment.organization_id = $1 AND payment.payable_id = $2
           ORDER BY payment.paid_at DESC, payment.id DESC`,
          [organizationId, payableId],
        ),
        client.query(
          `SELECT id, action, minimal_metadata, occurred_at FROM audit_events
           WHERE organization_id = $1 AND target_type = 'payable' AND target_id = $2
           ORDER BY occurred_at DESC, id DESC`,
          [organizationId, payableId],
        ),
      ])
      return {
        ...record,
        payments: payments.rows.map(mapFinancialPayment),
        history: history.rows.map((row) => ({
          id: row.id, action: row.action, minimalMetadata: row.minimal_metadata, occurredAt: row.occurred_at,
        })),
      }
    })
  }

  createPayable({ actorUserId, organizationId, payable: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT id, recurrence_id FROM payables WHERE organization_id = $1 AND idempotency_key = $2
         UNION ALL
         SELECT payable.id, payable.recurrence_id FROM payable_recurrences recurrence
         JOIN payables payable ON payable.organization_id = recurrence.organization_id
           AND payable.recurrence_id = recurrence.id
         WHERE recurrence.organization_id = $1 AND recurrence.idempotency_key = $2
         ORDER BY id`,
        [organizationId, input.idempotencyKey],
      )
      if (existing.rowCount) {
        const records = []
        for (const row of existing.rows) records.push(await selectPayable(client, organizationId, row.id))
        return { items: records, replayed: true }
      }
      const category = await client.query(
        `SELECT id FROM financial_categories WHERE organization_id = $1 AND id = $2
           AND active AND kind IN ('payable', 'both')`,
        [organizationId, input.categoryId],
      )
      if (!category.rowCount) {
        throw new ServiceError(400, 'INVALID_PAYABLE_REFERENCE', 'Categoria de despesa indisponível.')
      }
      const count = input.recurrence?.installmentCount ?? 1
      const recurrenceId = input.recurrence ? randomUUID() : null
      if (recurrenceId) {
        const insertedRecurrence = await client.query(
          `INSERT INTO payable_recurrences
            (id, organization_id, idempotency_key, frequency, installment_count)
           VALUES ($1, $2, $3, 'monthly', $4)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [recurrenceId, organizationId, input.idempotencyKey, count],
        )
        if (!insertedRecurrence.rowCount) {
          const replay = await client.query(
            `SELECT payable.id FROM payable_recurrences recurrence
             JOIN payables payable ON payable.organization_id = recurrence.organization_id
               AND payable.recurrence_id = recurrence.id
             WHERE recurrence.organization_id = $1 AND recurrence.idempotency_key = $2
             ORDER BY payable.installment_number`,
            [organizationId, input.idempotencyKey],
          )
          const replayedItems = []
          for (const row of replay.rows) replayedItems.push(await selectPayable(client, organizationId, row.id))
          return { items: replayedItems, replayed: true }
        }
      }
      const records = []
      for (let index = 0; index < count; index += 1) {
        const dueOn = addMonthsClamped(input.dueOn, index)
        const competenceOn = `${addMonthsClamped(input.competenceOn, index).slice(0, 7)}-01`
        const key = count === 1 ? input.idempotencyKey : `${input.idempotencyKey}:${index + 1}`
        const inserted = await client.query(
          `INSERT INTO payables
            (organization_id, category_id, counterparty, description, amount_cents, currency,
             competence_on, due_on, status, idempotency_key, recurrence_id, installment_number)
           VALUES ($1, $2, $3, $4, $5, 'BRL', $6, $7, 'open', $8, $9, $10)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            organizationId, input.categoryId, input.counterparty, input.description,
            input.amountCents, competenceOn, dueOn, key, recurrenceId,
            recurrenceId ? index + 1 : null,
          ],
        )
        if (!inserted.rowCount) {
          const replay = await client.query(
            `SELECT id FROM payables WHERE organization_id = $1 AND idempotency_key = $2`,
            [organizationId, key],
          )
          return { items: [await selectPayable(client, organizationId, replay.rows[0].id)], replayed: true }
        }
        const payableId = inserted.rows[0].id
        await appendAuditEvent(client, {
          organizationId, actorMembershipId: actor.id,
          action: 'payable.created', targetType: 'payable', targetId: payableId,
          minimalMetadata: {
            recurring: Boolean(recurrenceId),
            ...(recurrenceId ? { installmentNumber: index + 1, installmentCount: count } : {}),
          },
        })
        records.push(await selectPayable(client, organizationId, payableId))
      }
      return { items: records, replayed: false }
    })
  }

  updatePayable({ actorUserId, organizationId, payableId, payable: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT payable.status,
                (SELECT count(*)::int FROM payable_payments payment
                 WHERE payment.organization_id = payable.organization_id
                   AND payment.payable_id = payable.id
                   AND payment.reverses_payment_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM payable_payments reversal
                     WHERE reversal.organization_id = payment.organization_id
                       AND reversal.reverses_payment_id = payment.id
                   )) AS payment_count
         FROM payables payable
         WHERE payable.organization_id = $1 AND payable.id = $2
         FOR UPDATE`,
        [organizationId, payableId],
      )
      if (!existing.rowCount) return null
      if (existing.rows[0].status === 'cancelled' || existing.rows[0].payment_count > 0) {
        throw new ServiceError(409, 'PAYABLE_IMMUTABLE', 'A despesa cancelada ou com lançamentos não pode ser editada.')
      }
      const category = await client.query(
        `SELECT id FROM financial_categories WHERE organization_id = $1 AND id = $2
           AND active AND kind IN ('payable', 'both')`,
        [organizationId, input.categoryId],
      )
      if (!category.rowCount) throw new ServiceError(400, 'INVALID_PAYABLE_REFERENCE', 'Categoria de despesa indisponível.')
      await client.query(
        `UPDATE payables SET category_id = $3, counterparty = $4, description = $5,
           amount_cents = $6, competence_on = $7, due_on = $8
         WHERE organization_id = $1 AND id = $2`,
        [
          organizationId, payableId, input.categoryId, input.counterparty,
          input.description, input.amountCents, input.competenceOn, input.dueOn,
        ],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'payable.updated', targetType: 'payable', targetId: payableId,
        minimalMetadata: { fields: ['category', 'counterparty', 'description', 'amount', 'competence', 'dueOn'] },
      })
      return selectPayable(client, organizationId, payableId)
    })
  }

  cancelPayable({ actorUserId, organizationId, payableId, reason }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const existing = await client.query(
        `SELECT payable.status,
                (SELECT count(*)::int FROM payable_payments payment
                 WHERE payment.organization_id = payable.organization_id
                   AND payment.payable_id = payable.id
                   AND payment.reverses_payment_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM payable_payments reversal
                     WHERE reversal.organization_id = payment.organization_id
                       AND reversal.reverses_payment_id = payment.id
                   )) AS payment_count
         FROM payables payable
         WHERE payable.organization_id = $1 AND payable.id = $2
         FOR UPDATE`,
        [organizationId, payableId],
      )
      if (!existing.rowCount) return null
      if (existing.rows[0].status === 'cancelled') return selectPayable(client, organizationId, payableId)
      if (existing.rows[0].payment_count > 0) {
        throw new ServiceError(409, 'PAYABLE_HAS_PAYMENTS', 'Estorne as baixas antes de cancelar esta despesa.')
      }
      await client.query(
        `UPDATE payables SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $3
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, payableId, reason],
      )
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'payable.cancelled', targetType: 'payable', targetId: payableId,
        minimalMetadata: { reasonProvided: true },
      })
      return selectPayable(client, organizationId, payableId)
    })
  }

  createPayablePayment({ actorUserId, organizationId, payableId, payment: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const replay = await client.query(
        `SELECT id, payable_id FROM payable_payments WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, input.idempotencyKey],
      )
      if (replay.rowCount) {
        if (replay.rows[0].payable_id !== payableId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectPayablePayment(client, organizationId, replay.rows[0].id), replayed: true }
      }
      const account = await client.query(
        `SELECT payable.status, balance.balance_cents FROM payables payable
         JOIN payable_balances balance ON balance.organization_id = payable.organization_id
           AND balance.payable_id = payable.id
         WHERE payable.organization_id = $1 AND payable.id = $2 FOR UPDATE OF payable`,
        [organizationId, payableId],
      )
      if (!account.rowCount) return null
      if (account.rows[0].status === 'cancelled') {
        throw new ServiceError(409, 'PAYABLE_CANCELLED', 'Uma despesa cancelada não pode receber baixas.')
      }
      if (input.amountCents > Number(account.rows[0].balance_cents)) {
        throw new ServiceError(409, 'PAYABLE_PAYMENT_EXCEEDS_BALANCE', 'A baixa não pode superar o saldo da despesa.')
      }
      const inserted = await client.query(
        `INSERT INTO payable_payments
          (organization_id, payable_id, amount_cents, method, external_reference, paid_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          organizationId, payableId, input.amountCents, input.method,
          input.externalReference, input.paidAt, input.idempotencyKey,
        ],
      )
      if (!inserted.rowCount) {
        const concurrent = await client.query(
          `SELECT id, payable_id FROM payable_payments WHERE organization_id = $1 AND idempotency_key = $2`,
          [organizationId, input.idempotencyKey],
        )
        if (!concurrent.rowCount || concurrent.rows[0].payable_id !== payableId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectPayablePayment(client, organizationId, concurrent.rows[0].id), replayed: true }
      }
      const paymentId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'payable.payment.recorded', targetType: 'payable', targetId: payableId,
        minimalMetadata: { paymentId, method: input.method },
      })
      return { payment: await selectPayablePayment(client, organizationId, paymentId), replayed: false }
    })
  }

  createPayablePayments({ actorUserId, organizationId, payableId, payments: items }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const account = await client.query(
        `SELECT payable.status, balance.balance_cents FROM payables payable
         JOIN payable_balances balance ON balance.organization_id = payable.organization_id
           AND balance.payable_id = payable.id
         WHERE payable.organization_id = $1 AND payable.id = $2 FOR UPDATE OF payable`,
        [organizationId, payableId],
      )
      if (!account.rowCount) return null
      if (account.rows[0].status === 'cancelled') {
        throw new ServiceError(409, 'PAYABLE_CANCELLED', 'Uma despesa cancelada não pode receber baixas.')
      }
      const totalAmount = items.reduce((sum, item) => sum + item.amountCents, 0)
      if (totalAmount > Number(account.rows[0].balance_cents)) {
        throw new ServiceError(409, 'PAYABLE_PAYMENT_EXCEEDS_BALANCE', 'A baixa não pode superar o saldo da despesa.')
      }
      const createdPayments = []
      let anyReplayed = false
      for (const input of items) {
        const replay = await client.query(
          `SELECT id, payable_id FROM payable_payments WHERE organization_id = $1 AND idempotency_key = $2`,
          [organizationId, input.idempotencyKey],
        )
        if (replay.rowCount) {
          if (replay.rows[0].payable_id !== payableId) {
            throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
          }
          anyReplayed = true
          createdPayments.push(await selectPayablePayment(client, organizationId, replay.rows[0].id))
          continue
        }
        const inserted = await client.query(
          `INSERT INTO payable_payments
            (organization_id, payable_id, amount_cents, method, external_reference, paid_at, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            organizationId, payableId, input.amountCents, input.method,
            input.externalReference, input.paidAt, input.idempotencyKey,
          ],
        )
        const paymentId = inserted.rowCount
          ? inserted.rows[0].id
          : (await client.query(
              `SELECT id FROM payable_payments WHERE organization_id = $1 AND idempotency_key = $2`,
              [organizationId, input.idempotencyKey],
            )).rows[0].id

        await appendAuditEvent(client, {
          organizationId, actorMembershipId: actor.id,
          action: 'payable.payment.recorded', targetType: 'payable', targetId: payableId,
          minimalMetadata: { paymentId, method: input.method },
        })
        createdPayments.push(await selectPayablePayment(client, organizationId, paymentId))
      }
      return { payments: createdPayments, replayed: anyReplayed }
    })
  }

  reversePayablePayment({ actorUserId, organizationId, payableId, paymentId, reversal: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'finance.manage')
      const replay = await client.query(
        `SELECT id, payable_id, reverses_payment_id FROM payable_payments
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, input.idempotencyKey],
      )
      if (replay.rowCount) {
        if (replay.rows[0].payable_id !== payableId || replay.rows[0].reverses_payment_id !== paymentId) {
          throw new ServiceError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'A chave da operação já foi utilizada.')
        }
        return { payment: await selectPayablePayment(client, organizationId, replay.rows[0].id), replayed: true }
      }
      const original = await client.query(
        `SELECT payment.amount_cents, payment.method, reversal.id AS reversal_id
         FROM payable_payments payment
         JOIN payables payable ON payable.organization_id = payment.organization_id
           AND payable.id = payment.payable_id
         LEFT JOIN payable_payments reversal ON reversal.organization_id = payment.organization_id
           AND reversal.reverses_payment_id = payment.id
         WHERE payment.organization_id = $1 AND payment.payable_id = $2
           AND payment.id = $3 AND payment.reverses_payment_id IS NULL
         FOR UPDATE OF payment, payable`,
        [organizationId, payableId, paymentId],
      )
      if (!original.rowCount) return null
      if (original.rows[0].reversal_id) {
        throw new ServiceError(409, 'PAYABLE_PAYMENT_ALREADY_REVERSED', 'Esta baixa já foi estornada.')
      }
      const inserted = await client.query(
        `INSERT INTO payable_payments
          (organization_id, payable_id, reverses_payment_id, amount_cents, method,
           paid_at, idempotency_key, reversal_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          organizationId, payableId, paymentId, -Number(original.rows[0].amount_cents),
          original.rows[0].method, input.reversedAt, input.idempotencyKey, input.reason,
        ],
      )
      const reversalId = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: 'payable.payment.reversed', targetType: 'payable', targetId: payableId,
        minimalMetadata: { paymentId, reversalId, reasonProvided: true },
      })
      return { payment: await selectPayablePayment(client, organizationId, reversalId), replayed: false }
    })
  }

  listProspects({
    actorUserId, organizationId, stage = null, search = null, contactSearch = search,
    page = 1, pageSize = 50,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'prospects.read')
      const searchPattern = search ? `${search}%` : null
      const contactPattern = contactSearch ? `${contactSearch}%` : null
      const where = `prospect.organization_id = $1
        AND ($2::text IS NULL OR prospect.stage = $2)
        AND ($3::text IS NULL
          OR lower(prospect.full_name) LIKE $3
          OR EXISTS (
            SELECT 1 FROM prospect_contacts matched_contact
            WHERE matched_contact.organization_id = prospect.organization_id
              AND matched_contact.prospect_id = prospect.id
              AND matched_contact.normalized_value LIKE $4
          ))`
      const totalResult = await client.query(
        `SELECT count(*)::int AS total FROM prospects prospect WHERE ${where}`,
        [organizationId, stage, searchPattern, contactPattern],
      )
      const result = await client.query(
        `SELECT prospect.id, prospect.full_name, prospect.stage, prospect.source,
                prospect.owner_professional_id, owner.display_name AS owner_display_name,
                prospect.next_action_at, prospect.next_action_note,
                prospect.converted_client_id, prospect.converted_at,
                prospect.created_at, prospect.updated_at
         FROM prospects prospect
         LEFT JOIN professionals owner
           ON owner.organization_id = prospect.organization_id
          AND owner.id = prospect.owner_professional_id
         WHERE ${where}
         ORDER BY prospect.next_action_at ASC NULLS LAST, prospect.created_at DESC, prospect.id
         LIMIT $5 OFFSET $6`,
        [organizationId, stage, searchPattern, contactPattern, pageSize, (page - 1) * pageSize],
      )
      const ids = result.rows.map(({ id }) => id)
      const contacts = ids.length ? await client.query(
        `SELECT id, prospect_id, type, value, preferred FROM prospect_contacts
         WHERE organization_id = $1 AND prospect_id = ANY($2::uuid[])
         ORDER BY preferred DESC, type, value`,
        [organizationId, ids],
      ) : { rows: [] }
      const contactsByProspect = new Map()
      for (const contact of contacts.rows) {
        const current = contactsByProspect.get(contact.prospect_id) ?? []
        current.push(contact)
        contactsByProspect.set(contact.prospect_id, current)
      }
      const owners = await client.query(
        `SELECT id, display_name FROM professionals
         WHERE organization_id = $1 AND active AND deleted_at IS NULL
         ORDER BY display_name, id`,
        [organizationId],
      )
      const stageCounts = await client.query(
        `SELECT stage, count(*)::int AS count FROM prospects
         WHERE organization_id = $1 GROUP BY stage`,
        [organizationId],
      )
      return {
        items: result.rows.map((row) => mapProspect(row, contactsByProspect.get(row.id) ?? [])),
        total: totalResult.rows[0].total,
        owners: owners.rows.map((owner) => ({ id: owner.id, displayName: owner.display_name })),
        stageCounts: Object.fromEntries(stageCounts.rows.map(({ stage: key, count }) => [key, count])),
      }
    })
  }

  getProspect({ actorUserId, organizationId, prospectId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'prospects.read')
      return selectProspect(client, organizationId, prospectId)
    })
  }

  createProspect({ actorUserId, organizationId, prospect: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'prospects.manage')
      await requireActiveProspectOwner(client, organizationId, input.ownerProfessionalId)
      const result = await client.query(
        `INSERT INTO prospects
          (organization_id, owner_professional_id, full_name, stage, source,
           next_action_at, next_action_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          organizationId, input.ownerProfessionalId, input.fullName, input.stage,
          input.source, input.nextActionAt, input.nextActionNote,
        ],
      )
      const prospectId = result.rows[0].id
      await insertProspectContacts(client, organizationId, prospectId, input.contacts)
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'prospect.created',
        targetType: 'prospect',
        targetId: prospectId,
        minimalMetadata: {
          stage: input.stage,
          assigned: input.ownerProfessionalId !== null,
          contactTypes: [...new Set(input.contacts.map(({ type }) => type))],
          hasNextAction: input.nextActionAt !== null,
        },
      })
      return selectProspect(client, organizationId, prospectId)
    })
  }

  updateProspect({ actorUserId, organizationId, prospectId, prospect: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'prospects.manage')
      const existing = await client.query(
        `SELECT id, stage FROM prospects
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, prospectId],
      )
      if (!existing.rowCount) return null
      if (existing.rows[0].stage === 'converted') {
        throw new ServiceError(409, 'PROSPECT_CONVERTED', 'Uma prospecção convertida não pode ser alterada.')
      }
      await requireActiveProspectOwner(client, organizationId, input.ownerProfessionalId)
      await client.query(
        `UPDATE prospects
         SET owner_professional_id = $3, full_name = $4, stage = $5, source = $6,
             next_action_at = $7, next_action_note = $8
         WHERE organization_id = $1 AND id = $2`,
        [
          organizationId, prospectId, input.ownerProfessionalId, input.fullName,
          input.stage, input.source, input.nextActionAt, input.nextActionNote,
        ],
      )
      await client.query(
        'DELETE FROM prospect_contacts WHERE organization_id = $1 AND prospect_id = $2',
        [organizationId, prospectId],
      )
      await insertProspectContacts(client, organizationId, prospectId, input.contacts)
      if (existing.rows[0].stage !== input.stage) {
        await client.query(
          `INSERT INTO prospect_interactions
            (organization_id, prospect_id, type, notes, occurred_at)
           VALUES ($1, $2, 'stage_change', NULL, now())`,
          [organizationId, prospectId],
        )
      }
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'prospect.updated',
        targetType: 'prospect',
        targetId: prospectId,
        minimalMetadata: {
          stage: input.stage,
          previousStage: existing.rows[0].stage,
          assigned: input.ownerProfessionalId !== null,
          contactTypes: [...new Set(input.contacts.map(({ type }) => type))],
          hasNextAction: input.nextActionAt !== null,
        },
      })
      return selectProspect(client, organizationId, prospectId)
    })
  }

  addProspectInteraction({ actorUserId, organizationId, prospectId, interaction: input }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'prospects.manage')
      const prospect = await client.query(
        'SELECT id FROM prospects WHERE organization_id = $1 AND id = $2',
        [organizationId, prospectId],
      )
      if (!prospect.rowCount) return null
      const result = await client.query(
        `INSERT INTO prospect_interactions
          (organization_id, prospect_id, type, notes, occurred_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, type, notes, occurred_at`,
        [organizationId, prospectId, input.type, input.notes, input.occurredAt],
      )
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'prospect.interaction.created',
        targetType: 'prospect',
        targetId: prospectId,
        minimalMetadata: { type: input.type },
      })
      const row = result.rows[0]
      return { id: row.id, type: row.type, notes: row.notes, occurredAt: row.occurred_at }
    })
  }

  convertProspect({ actorUserId, organizationId, prospectId, conversion }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'prospects.manage')
      await this.#requirePermission(client, actorUserId, organizationId, 'clients.manage')
      const prospect = await client.query(
        `SELECT id, full_name, stage, converted_client_id FROM prospects
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, prospectId],
      )
      if (!prospect.rowCount) return null
      const current = prospect.rows[0]
      if (current.converted_client_id) {
        return {
          created: false,
          prospect: await selectProspect(client, organizationId, prospectId),
          client: await selectClient(client, organizationId, current.converted_client_id),
        }
      }
      const contacts = await client.query(
        `SELECT type, value, normalized_value, preferred FROM prospect_contacts
         WHERE organization_id = $1 AND prospect_id = $2
         ORDER BY preferred DESC, type, value`,
        [organizationId, prospectId],
      )
      const inserted = await client.query(
        `INSERT INTO clients
          (organization_id, full_name, birth_date, document_number, document_normalized, client_type)
         VALUES ($1, $2, $3, $4, $4, $5)
         RETURNING id`,
        [organizationId, current.full_name, conversion.birthDate, conversion.documentNumber, conversion.clientType],
      )
      const clientId = inserted.rows[0].id
      await insertClientContacts(client, organizationId, clientId, contacts.rows.map((contact) => ({
        type: contact.type,
        value: contact.value,
        normalizedValue: contact.normalized_value,
        preferred: contact.preferred,
      })))
      await client.query(
        `UPDATE prospects
         SET stage = 'converted', converted_client_id = $3, converted_at = now(),
             next_action_at = NULL, next_action_note = NULL
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, prospectId, clientId],
      )
      await client.query(
        `INSERT INTO prospect_interactions
          (organization_id, prospect_id, type, notes, occurred_at)
         VALUES ($1, $2, 'conversion', NULL, now())`,
        [organizationId, prospectId],
      )
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'client.created',
        targetType: 'client',
        targetId: clientId,
        minimalMetadata: { clientType: conversion.clientType, origin: 'prospect_conversion' },
      })
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'prospect.converted',
        targetType: 'prospect',
        targetId: prospectId,
        minimalMetadata: {
          clientId,
          clientType: conversion.clientType,
          previousStage: current.stage,
        },
      })
      return {
        created: true,
        prospect: await selectProspect(client, organizationId, prospectId),
        client: await selectClient(client, organizationId, clientId),
      }
    })
  }

  listResources({ actorUserId, organizationId, active = null }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      await this.#requirePermission(client, actorUserId, organizationId, 'resources.read')
      const modalities = await client.query(
        `SELECT resource.*,
           (SELECT count(*)::int FROM services linked
            WHERE linked.organization_id = resource.organization_id
              AND linked.modality_id = resource.id) AS associations_count
         FROM modalities resource
         WHERE resource.organization_id = $1 AND ($2::boolean IS NULL OR resource.active = $2)
         ORDER BY resource.active DESC, resource.name, resource.id`,
        [organizationId, active],
      )
      const services = await client.query(
        `SELECT resource.*, modality.name AS modality_name,
           (SELECT count(*)::int FROM appointments linked
            WHERE linked.organization_id = resource.organization_id
              AND linked.service_id = resource.id) AS associations_count
         FROM services resource
         JOIN modalities modality
           ON modality.organization_id = resource.organization_id AND modality.id = resource.modality_id
         WHERE resource.organization_id = $1 AND ($2::boolean IS NULL OR resource.active = $2)
         ORDER BY resource.active DESC, resource.name, resource.id`,
        [organizationId, active],
      )
      const rooms = await client.query(
        `SELECT resource.*, unit.name AS unit_name,
           (SELECT count(*)::int FROM appointments linked
            WHERE linked.organization_id = resource.organization_id
              AND linked.room_id = resource.id) AS associations_count
         FROM rooms resource
         JOIN units unit
           ON unit.organization_id = resource.organization_id AND unit.id = resource.unit_id
         WHERE resource.organization_id = $1 AND ($2::boolean IS NULL OR resource.active = $2)
         ORDER BY resource.active DESC, resource.name, resource.id`,
        [organizationId, active],
      )
      const equipment = await client.query(
        `SELECT resource.*, unit.name AS unit_name,
           (SELECT count(DISTINCT linked.appointment_id)::int FROM appointment_equipment linked
            WHERE linked.organization_id = resource.organization_id
              AND linked.equipment_id = resource.id) AS associations_count
         FROM equipment resource
         JOIN units unit
           ON unit.organization_id = resource.organization_id AND unit.id = resource.unit_id
         WHERE resource.organization_id = $1 AND ($2::boolean IS NULL OR resource.active = $2)
         ORDER BY resource.active DESC, resource.name, resource.id`,
        [organizationId, active],
      )
      const units = await client.query(
        `SELECT id, name, active FROM units
         WHERE organization_id = $1 ORDER BY active DESC, name, id`,
        [organizationId],
      )
      return {
        modalities: modalities.rows.map((row) => mapResourceRow('modalities', row)),
        services: services.rows.map((row) => mapResourceRow('services', row)),
        rooms: rooms.rows.map((row) => mapResourceRow('rooms', row)),
        equipment: equipment.rows.map((row) => mapResourceRow('equipment', row)),
        units: units.rows,
      }
    })
  }

  createResource({ actorUserId, organizationId, kind, resource }) {
    return inTransaction(this.pool, async (client) => {
      if (!resourceTables[kind]) throw new ServiceError(404, 'RESOURCE_KIND_NOT_FOUND', 'Tipo de recurso não encontrado.')
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'resources.manage')
      let result
      if (kind === 'modalities') result = await client.query(
        `INSERT INTO modalities (organization_id, name, active) VALUES ($1, $2, $3) RETURNING id`,
        [organizationId, resource.name, resource.active],
      )
      if (kind === 'services') result = await client.query(
        `INSERT INTO services
          (organization_id, modality_id, name, duration_minutes, default_capacity, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [organizationId, resource.modalityId, resource.name, resource.durationMinutes,
          resource.defaultCapacity, resource.active],
      )
      if (kind === 'rooms') result = await client.query(
        `INSERT INTO rooms (organization_id, unit_id, name, capacity, active)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organizationId, resource.unitId, resource.name, resource.capacity, resource.active],
      )
      if (kind === 'equipment') result = await client.query(
        `INSERT INTO equipment (organization_id, unit_id, name, quantity, active)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organizationId, resource.unitId, resource.name, resource.quantity, resource.active],
      )
      const resourceId = result.rows[0].id
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'resource.created',
        targetType: resourceTargetTypes[kind],
        targetId: resourceId,
        minimalMetadata: { kind, active: resource.active },
      })
      return selectResource(client, organizationId, kind, resourceId)
    })
  }

  updateResource({ actorUserId, organizationId, kind, resourceId, resource }) {
    return inTransaction(this.pool, async (client) => {
      const tableName = resourceTables[kind]
      if (!tableName) throw new ServiceError(404, 'RESOURCE_KIND_NOT_FOUND', 'Tipo de recurso não encontrado.')
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'resources.manage')
      const existing = await client.query(
        `SELECT active FROM ${tableName} WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, resourceId],
      )
      if (!existing.rowCount) return null
      if (kind === 'modalities') await client.query(
        `UPDATE modalities SET name = $3, active = $4
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, resourceId, resource.name, resource.active],
      )
      if (kind === 'services') await client.query(
        `UPDATE services SET modality_id = $3, name = $4, duration_minutes = $5,
           default_capacity = $6, active = $7 WHERE organization_id = $1 AND id = $2`,
        [organizationId, resourceId, resource.modalityId, resource.name,
          resource.durationMinutes, resource.defaultCapacity, resource.active],
      )
      if (kind === 'rooms') await client.query(
        `UPDATE rooms SET unit_id = $3, name = $4, capacity = $5, active = $6
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, resourceId, resource.unitId, resource.name, resource.capacity, resource.active],
      )
      if (kind === 'equipment') await client.query(
        `UPDATE equipment SET unit_id = $3, name = $4, quantity = $5, active = $6
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, resourceId, resource.unitId, resource.name, resource.quantity, resource.active],
      )
      await appendAuditEvent(client, {
        organizationId,
        actorMembershipId: actor.id,
        action: 'resource.updated',
        targetType: resourceTargetTypes[kind],
        targetId: resourceId,
        minimalMetadata: {
          kind,
          active: resource.active,
          previousActive: existing.rows[0].active,
        },
      })
      return selectResource(client, organizationId, kind, resourceId)
    })
  }

  listAvailability({ actorUserId, organizationId, professionalId = null }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.read')
      const effectiveProfessionalId = actor.role_code === 'professional'
        ? actor.professional_id : professionalId
      if (actor.role_code === 'professional' && !effectiveProfessionalId) {
        throw new ServiceError(403, 'PERMISSION_DENIED', 'O usuário não possui vínculo profissional ativo.')
      }
      const result = await client.query(
        `SELECT rule.*, professional.display_name AS professional_name, unit.name AS unit_name
         FROM availability_rules rule
         JOIN professionals professional
           ON professional.organization_id = rule.organization_id AND professional.id = rule.professional_id
         JOIN units unit ON unit.organization_id = rule.organization_id AND unit.id = rule.unit_id
         WHERE rule.organization_id = $1
           AND ($2::uuid IS NULL OR rule.professional_id = $2)
         ORDER BY rule.active DESC, professional.display_name, rule.weekday NULLS LAST,
                  rule.starts_at NULLS LAST, rule.local_start_time NULLS LAST, rule.id`,
        [organizationId, effectiveProfessionalId],
      )
      const references = await this.#scheduleReferences(client, organizationId, actor)
      return { rules: result.rows.map(mapAvailability), ...references }
    })
  }

  createAvailability({ actorUserId, organizationId, availability }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      this.#requireProfessionalScope(actor, availability.professionalId)
      const reference = await client.query(
        `SELECT professional.id FROM professionals professional
         JOIN units unit ON unit.organization_id = professional.organization_id AND unit.id = $3
         WHERE professional.organization_id = $1 AND professional.id = $2
           AND professional.active AND professional.deleted_at IS NULL AND unit.active
         FOR UPDATE OF professional, unit`,
        [organizationId, availability.professionalId, availability.unitId],
      )
      if (!reference.rowCount) {
        throw new ServiceError(400, 'INVALID_AVAILABILITY_REFERENCE', 'Profissional ou unidade indisponível.')
      }
      const inserted = await client.query(
        `INSERT INTO availability_rules
          (organization_id, professional_id, unit_id, rule_type, kind, weekday,
           local_start_time, local_end_time, starts_at, ends_at, timezone, label, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          organizationId, availability.professionalId, availability.unitId,
          availability.kind === 'working_hours' ? 'available' : 'blocked', availability.kind,
          availability.weekday, availability.localStartTime, availability.localEndTime,
          availability.startsAt, availability.endsAt, availability.timezone,
          availability.label, availability.active,
        ],
      )
      await ensureAvailabilityKeepsAppointmentsValid(
        client, organizationId, availability.professionalId, availability.unitId,
      )
      const id = inserted.rows[0].id
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id, action: 'availability.created',
        targetType: 'availability_rule', targetId: id,
        minimalMetadata: { kind: availability.kind, active: availability.active },
      })
      return this.#selectAvailability(client, organizationId, id)
    })
  }

  updateAvailability({ actorUserId, organizationId, availabilityId, availability }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT professional_id, unit_id, kind, active FROM availability_rules
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, availabilityId],
      )
      if (!current.rowCount) return null
      this.#requireProfessionalScope(actor, current.rows[0].professional_id)
      this.#requireProfessionalScope(actor, availability.professionalId)
      const reference = await client.query(
        `SELECT professional.id FROM professionals professional
         JOIN units unit ON unit.organization_id = professional.organization_id AND unit.id = $3
         WHERE professional.organization_id = $1 AND professional.id = $2
           AND professional.active AND professional.deleted_at IS NULL AND unit.active
         FOR UPDATE OF professional, unit`,
        [organizationId, availability.professionalId, availability.unitId],
      )
      if (!reference.rowCount) {
        throw new ServiceError(400, 'INVALID_AVAILABILITY_REFERENCE', 'Profissional ou unidade indisponível.')
      }
      await client.query(
        `UPDATE availability_rules
         SET professional_id = $3, unit_id = $4, rule_type = $5, kind = $6,
             weekday = $7, local_start_time = $8, local_end_time = $9,
             starts_at = $10, ends_at = $11, timezone = $12, label = $13, active = $14
         WHERE organization_id = $1 AND id = $2`,
        [
          organizationId, availabilityId, availability.professionalId, availability.unitId,
          availability.kind === 'working_hours' ? 'available' : 'blocked', availability.kind,
          availability.weekday, availability.localStartTime, availability.localEndTime,
          availability.startsAt, availability.endsAt, availability.timezone,
          availability.label, availability.active,
        ],
      )
      await ensureAvailabilityKeepsAppointmentsValid(
        client, organizationId, current.rows[0].professional_id, current.rows[0].unit_id,
      )
      if (current.rows[0].professional_id !== availability.professionalId
        || current.rows[0].unit_id !== availability.unitId) {
        await ensureAvailabilityKeepsAppointmentsValid(
          client, organizationId, availability.professionalId, availability.unitId,
        )
      }
      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id, action: 'availability.updated',
        targetType: 'availability_rule', targetId: availabilityId,
        minimalMetadata: {
          kind: availability.kind, previousKind: current.rows[0].kind,
          active: availability.active, previousActive: current.rows[0].active,
        },
      })
      return this.#selectAvailability(client, organizationId, availabilityId)
    })
  }

  getSchedule({ actorUserId, organizationId, from, to, professionalId = null }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.read')
      const effectiveProfessionalId = actor.role_code === 'professional'
        ? actor.professional_id : professionalId
      if (actor.role_code === 'professional' && !effectiveProfessionalId) {
        throw new ServiceError(403, 'PERMISSION_DENIED', 'O usuário não possui vínculo profissional ativo.')
      }
      const waitlisted = await client.query(
        `SELECT DISTINCT entry.appointment_id
         FROM waitlist_entries entry
         JOIN appointments appointment
           ON appointment.organization_id = entry.organization_id
          AND appointment.id = entry.appointment_id
         WHERE entry.organization_id = $1
           AND entry.status IN ('queued', 'offered')
           AND appointment.starts_at < $3 AND appointment.ends_at > $2
           AND ($4::uuid IS NULL OR appointment.professional_id = $4)`,
        [organizationId, from, to, effectiveProfessionalId],
      )
      for (const row of waitlisted.rows) {
        await advanceWaitlistOffer(client, organizationId, row.appointment_id)
      }
      const result = await client.query(
        `${appointmentSelect}
         WHERE appointment.organization_id = $1
           AND appointment.starts_at < $3 AND appointment.ends_at > $2
           AND ($4::uuid IS NULL OR appointment.professional_id = $4)
         ORDER BY appointment.starts_at, appointment.id`,
        [organizationId, from, to, effectiveProfessionalId],
      )
      return {
        appointments: result.rows.map(mapAppointment),
        ...(await this.#scheduleReferences(client, organizationId, actor)),
      }
    })
  }

  createAppointment({ actorUserId, organizationId, appointment }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      this.#requireProfessionalScope(actor, appointment.professionalId)
      const inserted = await client.query(
        `INSERT INTO appointments
          (organization_id, unit_id, service_id, professional_id, room_id,
           starts_at, ends_at, capacity)
         SELECT $1, $2, service.id, $4, $5, $6,
                $6::timestamptz + service.duration_minutes * interval '1 minute', 1
         FROM services service
         WHERE service.organization_id = $1 AND service.id = $3 AND service.active
         RETURNING id`,
        [
          organizationId, appointment.unitId, appointment.serviceId,
          appointment.professionalId, appointment.roomId, appointment.startsAt,
        ],
      )
      if (!inserted.rowCount) {
        throw new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O serviço não está disponível.')
      }
      const appointmentId = inserted.rows[0].id
      await replaceAppointmentEquipment(client, organizationId, [appointmentId], appointment.equipment)
      await client.query(
        `INSERT INTO appointment_participants
          (organization_id, appointment_id, client_id, status)
         VALUES ($1, $2, $3, 'confirmed')`,
        [organizationId, appointmentId, appointment.clientId],
      )
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'appointment.created',
      })
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  createClassAppointment({ actorUserId, organizationId, appointment }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      this.#requireProfessionalScope(actor, appointment.professionalId)
      const inserted = await client.query(
        `INSERT INTO appointments
          (organization_id, unit_id, service_id, professional_id, room_id,
           starts_at, ends_at, capacity, appointment_type)
         SELECT $1, $2, service.id, $4, $5, $6,
                $6::timestamptz + service.duration_minutes * interval '1 minute', $7, 'class'
         FROM services service
         WHERE service.organization_id = $1 AND service.id = $3 AND service.active
         RETURNING id`,
        [
          organizationId, appointment.unitId, appointment.serviceId,
          appointment.professionalId, appointment.roomId, appointment.startsAt, appointment.capacity,
        ],
      )
      if (!inserted.rowCount) {
        throw new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O serviço não está disponível.')
      }
      const appointmentId = inserted.rows[0].id
      await replaceAppointmentEquipment(client, organizationId, [appointmentId], appointment.equipment)
      for (const clientId of appointment.clientIds) {
        await client.query(
          `INSERT INTO appointment_participants
            (organization_id, appointment_id, client_id, status)
           VALUES ($1, $2, $3, 'confirmed')`,
          [organizationId, appointmentId, clientId],
        )
      }
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'class.created', appointmentType: 'class',
      })
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  addAppointmentParticipant({ actorUserId, organizationId, appointmentId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const appointment = await client.query(
        `SELECT professional_id, appointment_type, status FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) return null
      this.#requireProfessionalScope(actor, appointment.rows[0].professional_id)
      if (appointment.rows[0].appointment_type !== 'class' || appointment.rows[0].status !== 'scheduled') {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'Apenas turmas ativas recebem participantes.')
      }
      await advanceWaitlistOffer(client, organizationId, appointmentId)
      const activeOffer = await client.query(
        `SELECT id FROM waitlist_offers
         WHERE organization_id = $1 AND appointment_id = $2
           AND status = 'active' AND expires_at > clock_timestamp()`,
        [organizationId, appointmentId],
      )
      if (activeOffer.rowCount) {
        throw new ServiceError(
          409, 'WAITLIST_OFFER_ACTIVE',
          'A vaga está reservada temporariamente para uma pessoa da fila de interesse.',
        )
      }
      const existing = await client.query(
        `SELECT id FROM appointment_participants
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('booked', 'confirmed', 'attended')`,
        [organizationId, appointmentId, clientId],
      )
      if (existing.rowCount) return selectAppointment(client, organizationId, appointmentId)
      await client.query(
        `INSERT INTO appointment_participants
          (organization_id, appointment_id, client_id, status)
         VALUES ($1, $2, $3, 'confirmed')
         ON CONFLICT (organization_id, appointment_id, client_id)
           WHERE status IN ('booked', 'confirmed', 'attended') DO NOTHING`,
        [organizationId, appointmentId, clientId],
      )
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'class.participant_added', appointmentType: 'class',
      })
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  cancelAppointmentParticipant({ actorUserId, organizationId, appointmentId, clientId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const appointment = await client.query(
        `SELECT professional_id, appointment_type FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!appointment.rowCount) return null
      this.#requireProfessionalScope(actor, appointment.rows[0].professional_id)
      if (appointment.rows[0].appointment_type !== 'class') {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'O agendamento não é uma turma.')
      }
      const cancelled = await client.query(
        `UPDATE appointment_participants SET status = 'cancelled'
         WHERE organization_id = $1 AND appointment_id = $2 AND client_id = $3
           AND status IN ('booked', 'confirmed') RETURNING id`,
        [organizationId, appointmentId, clientId],
      )
      if (!cancelled.rowCount) {
        throw new ServiceError(404, 'PARTICIPANT_NOT_FOUND', 'Participante ativo não encontrado.')
      }
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'class.participant_cancelled', appointmentType: 'class',
      })
      await advanceWaitlistOffer(client, organizationId, appointmentId)
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  updateAppointmentParticipantStatus({
    actorUserId, organizationId, appointmentId, participantId, status, reason,
  }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT participant.status AS participant_status, appointment.professional_id,
                appointment.appointment_type, appointment.status AS appointment_status
         FROM appointment_participants participant
         JOIN appointments appointment
           ON appointment.organization_id = participant.organization_id
          AND appointment.id = participant.appointment_id
         WHERE participant.organization_id = $1 AND participant.appointment_id = $2
           AND participant.id = $3
         FOR UPDATE OF participant, appointment`,
        [organizationId, appointmentId, participantId],
      )
      if (!current.rowCount) return null
      const previous = current.rows[0]
      this.#requireProfessionalScope(actor, previous.professional_id)
      if (previous.participant_status === status) {
        return selectAppointment(client, organizationId, appointmentId)
      }
      await client.query(
        `UPDATE appointment_participants
         SET status = $4, cancellation_reason = $5
         WHERE organization_id = $1 AND appointment_id = $2 AND id = $3`,
        [organizationId, appointmentId, participantId, status, reason],
      )

      if (status === 'cancelled' && previous.appointment_type === 'individual') {
        await client.query(
          `UPDATE appointments
           SET status = 'cancelled', cancelled_at = now(), cancelled_by_membership_id = $3
           WHERE organization_id = $1 AND id = $2 AND status = 'scheduled'`,
          [organizationId, appointmentId, actor.id],
        )
      } else if (status === 'attended' || status === 'absent') {
        await client.query(
          `UPDATE appointments appointment SET status = 'completed'
           WHERE appointment.organization_id = $1 AND appointment.id = $2
             AND appointment.status = 'scheduled'
             AND NOT EXISTS (
               SELECT 1 FROM appointment_participants pending
               WHERE pending.organization_id = appointment.organization_id
                 AND pending.appointment_id = appointment.id
                 AND pending.status IN ('booked', 'confirmed')
             )`,
          [organizationId, appointmentId],
        )
      }

      if (status === 'cancelled' && previous.appointment_type === 'class'
        && previous.appointment_status === 'scheduled') {
        await advanceWaitlistOffer(client, organizationId, appointmentId)
      }

      await appendAuditEvent(client, {
        organizationId, actorMembershipId: actor.id,
        action: `participant.${status}`,
        targetType: 'appointment_participant', targetId: participantId,
        minimalMetadata: {
          appointmentId, fromStatus: previous.participant_status, toStatus: status,
        },
      })
      await client.query(
        `INSERT INTO outbox_events
          (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
         VALUES ($1, 'appointment_participant', $2, $3, '{}'::jsonb, $4)`,
        [organizationId, participantId, `participant.${status}`,
          `participant.${status}:${participantId}:${randomUUID()}`],
      )
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  createAppointmentSeries({ actorUserId, organizationId, series }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      this.#requireProfessionalScope(actor, series.professionalId)
      const rule = await client.query(
        `INSERT INTO recurrence_rules
          (organization_id, recurrence_expression, series_start, series_end, timezone,
           frequency, interval_count, occurrence_count, created_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, 'weekly', $6, $7, $8)
         RETURNING id`,
        [
          organizationId, series.recurrenceExpression, series.seriesStart, series.seriesEnd,
          series.timezone, series.interval, series.occurrences.length, actor.id,
        ],
      )
      const recurrenceRuleId = rule.rows[0].id
      const created = []
      for (const [occurrenceIndex, startsAt] of series.occurrences.entries()) {
        const inserted = await client.query(
          `INSERT INTO appointments
            (organization_id, unit_id, service_id, professional_id, room_id,
             recurrence_rule_id, occurrence_index, starts_at, ends_at, capacity, appointment_type)
           SELECT $1, $2, service.id, $4, $5, $6, $7, $8,
                  $8::timestamptz + service.duration_minutes * interval '1 minute', 1, 'individual'
           FROM services service
           WHERE service.organization_id = $1 AND service.id = $3 AND service.active
           RETURNING id`,
          [
            organizationId, series.unitId, series.serviceId, series.professionalId, series.roomId,
            recurrenceRuleId, occurrenceIndex, startsAt,
          ],
        )
        if (!inserted.rowCount) {
          throw new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O serviço não está disponível.')
        }
        const appointmentId = inserted.rows[0].id
        await replaceAppointmentEquipment(client, organizationId, [appointmentId], series.equipment)
        await client.query(
          `INSERT INTO appointment_participants
            (organization_id, appointment_id, client_id, status)
           VALUES ($1, $2, $3, 'confirmed')`,
          [organizationId, appointmentId, series.clientId],
        )
        await this.#appendScheduleMutation(client, {
          organizationId, actor, appointmentId, action: 'appointment.series_created',
          appointmentType: 'recurring', scope: 'series',
        })
        created.push(await selectAppointment(client, organizationId, appointmentId))
      }
      return { id: recurrenceRuleId, appointments: created }
    })
  }

  updateAppointmentOccurrences({ actorUserId, organizationId, appointmentId, scope, appointment }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT professional_id, recurrence_rule_id, occurrence_index, starts_at, status
         FROM appointments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!current.rowCount) return null
      const selected = current.rows[0]
      if (!selected.recurrence_rule_id || selected.status !== 'scheduled') {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'A ocorrência não pertence a uma série ativa.')
      }
      this.#requireProfessionalScope(actor, selected.professional_id)
      this.#requireProfessionalScope(actor, appointment.professionalId)
      const future = scope === 'future'
      const deltaMilliseconds = appointment.startsAt.getTime() - new Date(selected.starts_at).getTime()
      const affected = await client.query(
        `SELECT id FROM appointments target
         WHERE target.organization_id = $1
           AND ((NOT $3::boolean AND target.id = $2)
             OR ($3::boolean AND target.recurrence_rule_id = $4
               AND target.occurrence_index >= $5 AND target.status = 'scheduled'))
         ORDER BY target.occurrence_index NULLS FIRST, target.id
         FOR UPDATE`,
        [organizationId, appointmentId, future, selected.recurrence_rule_id, selected.occurrence_index],
      )
      await replaceAppointmentEquipment(
        client, organizationId, affected.rows.map(({ id }) => id), [],
      )
      const updated = await client.query(
        `UPDATE appointments target
         SET unit_id = $5, service_id = service.id, professional_id = $7, room_id = $8,
             starts_at = CASE WHEN target.id = $2 THEN $9::timestamptz
               ELSE target.starts_at + ($10::bigint * interval '1 millisecond') END,
             ends_at = CASE WHEN target.id = $2 THEN $9::timestamptz
               ELSE target.starts_at + ($10::bigint * interval '1 millisecond') END
               + service.duration_minutes * interval '1 minute'
         FROM services service
         WHERE target.organization_id = $1
           AND service.organization_id = $1 AND service.id = $6 AND service.active
           AND ((NOT $3::boolean AND target.id = $2)
             OR ($3::boolean AND target.recurrence_rule_id = $4
               AND target.occurrence_index >= $11 AND target.status = 'scheduled'))
         RETURNING target.id`,
        [
          organizationId, appointmentId, future, selected.recurrence_rule_id,
          appointment.unitId, appointment.serviceId, appointment.professionalId, appointment.roomId,
          appointment.startsAt, deltaMilliseconds, selected.occurrence_index,
        ],
      )
      if (!updated.rowCount) {
        throw new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O serviço não está disponível.')
      }
      const ids = updated.rows.map(({ id }) => id)
      await replaceAppointmentEquipment(client, organizationId, ids, appointment.equipment)
      await client.query(
        `UPDATE appointment_participants SET client_id = $3
         WHERE organization_id = $1 AND appointment_id = ANY($2::uuid[])
           AND status IN ('booked', 'confirmed')`,
        [organizationId, ids, appointment.clientId],
      )
      for (const id of ids) {
        await this.#appendScheduleMutation(client, {
          organizationId, actor, appointmentId: id, action: 'appointment.series_updated',
          appointmentType: 'recurring', scope,
        })
      }
      return {
        scope,
        appointments: await Promise.all(ids.map((id) => selectAppointment(client, organizationId, id))),
      }
    })
  }

  updateAppointment({ actorUserId, organizationId, appointmentId, appointment }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT professional_id, status, appointment_type, recurrence_rule_id FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!current.rowCount) return null
      if (current.rows[0].status !== 'scheduled') {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'Somente agendamentos ativos podem ser alterados.')
      }
      if (current.rows[0].appointment_type !== 'individual' || current.rows[0].recurrence_rule_id) {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'Use a operação específica para turma ou série.')
      }
      this.#requireProfessionalScope(actor, current.rows[0].professional_id)
      this.#requireProfessionalScope(actor, appointment.professionalId)
      await replaceAppointmentEquipment(client, organizationId, [appointmentId], [])
      const updated = await client.query(
        `UPDATE appointments appointment
         SET unit_id = $3, service_id = service.id, professional_id = $5,
             room_id = $6, starts_at = $7,
             ends_at = $7::timestamptz + service.duration_minutes * interval '1 minute'
         FROM services service
         WHERE appointment.organization_id = $1 AND appointment.id = $2
           AND service.organization_id = $1 AND service.id = $4 AND service.active
         RETURNING appointment.id`,
        [
          organizationId, appointmentId, appointment.unitId, appointment.serviceId,
          appointment.professionalId, appointment.roomId, appointment.startsAt,
        ],
      )
      if (!updated.rowCount) {
        throw new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O serviço não está disponível.')
      }
      await replaceAppointmentEquipment(client, organizationId, [appointmentId], appointment.equipment)
      await client.query(
        `UPDATE appointment_participants SET client_id = $3
         WHERE organization_id = $1 AND appointment_id = $2
           AND status IN ('booked', 'confirmed')`,
        [organizationId, appointmentId, appointment.clientId],
      )
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'appointment.updated',
      })
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  cancelAppointment({ actorUserId, organizationId, appointmentId }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, actorUserId, organizationId)
      const actor = await this.#requirePermission(client, actorUserId, organizationId, 'schedule.manage')
      const current = await client.query(
        `SELECT professional_id, status FROM appointments
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, appointmentId],
      )
      if (!current.rowCount) return null
      this.#requireProfessionalScope(actor, current.rows[0].professional_id)
      if (current.rows[0].status === 'cancelled') return selectAppointment(client, organizationId, appointmentId)
      if (current.rows[0].status !== 'scheduled') {
        throw new ServiceError(409, 'INVALID_APPOINTMENT_STATE', 'Somente agendamentos ativos podem ser cancelados.')
      }
      await client.query(
        `UPDATE appointment_participants
         SET status = 'cancelled', cancellation_reason = NULL
         WHERE organization_id = $1 AND appointment_id = $2
           AND status IN ('booked', 'confirmed')`,
        [organizationId, appointmentId],
      )
      await client.query(
        `UPDATE appointments
         SET status = 'cancelled', cancelled_at = now(), cancelled_by_membership_id = $3
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, appointmentId, actor.id],
      )
      await client.query(
        `UPDATE waitlist_offers SET status = 'cancelled'
         WHERE organization_id = $1 AND appointment_id = $2 AND status = 'active'`,
        [organizationId, appointmentId],
      )
      await client.query(
        `UPDATE waitlist_entries SET status = 'cancelled'
         WHERE organization_id = $1 AND appointment_id = $2
           AND status IN ('queued', 'offered')`,
        [organizationId, appointmentId],
      )
      await this.#appendScheduleMutation(client, {
        organizationId, actor, appointmentId, action: 'appointment.cancelled',
      })
      return selectAppointment(client, organizationId, appointmentId)
    })
  }

  #requireProfessionalScope(actor, professionalId) {
    if (actor.role_code === 'professional' && actor.professional_id !== professionalId) {
      throw new ServiceError(403, 'PERMISSION_DENIED', 'Profissionais só podem gerenciar a própria agenda.')
    }
  }

  async #selectAvailability(client, organizationId, availabilityId) {
    const result = await client.query(
      `SELECT rule.*, professional.display_name AS professional_name, unit.name AS unit_name
       FROM availability_rules rule
       JOIN professionals professional
         ON professional.organization_id = rule.organization_id AND professional.id = rule.professional_id
       JOIN units unit ON unit.organization_id = rule.organization_id AND unit.id = rule.unit_id
       WHERE rule.organization_id = $1 AND rule.id = $2`,
      [organizationId, availabilityId],
    )
    return result.rowCount ? mapAvailability(result.rows[0]) : null
  }

  async #scheduleReferences(client, organizationId, actor) {
    const ownOnly = actor.role_code === 'professional'
    const [professionals, units, services, rooms, equipment, clients] = await Promise.all([
      client.query(
        `SELECT id, display_name FROM professionals
         WHERE organization_id = $1 AND active AND deleted_at IS NULL
           AND (NOT $2::boolean OR id = $3)
         ORDER BY display_name, id`,
        [organizationId, ownOnly, actor.professional_id],
      ),
      client.query('SELECT id, name, timezone FROM units WHERE organization_id = $1 AND active ORDER BY name, id', [organizationId]),
      client.query(
        `SELECT service.id, service.name, service.duration_minutes, service.default_capacity
         FROM services service JOIN modalities modality
           ON modality.organization_id = service.organization_id AND modality.id = service.modality_id
         WHERE service.organization_id = $1 AND service.active AND modality.active ORDER BY service.name, service.id`,
        [organizationId],
      ),
      client.query(
        'SELECT id, unit_id, name, capacity FROM rooms WHERE organization_id = $1 AND active ORDER BY name, id',
        [organizationId],
      ),
      client.query(
        'SELECT id, unit_id, name, quantity FROM equipment WHERE organization_id = $1 AND active ORDER BY name, id',
        [organizationId],
      ),
      client.query(
        `SELECT id, full_name, client_type FROM clients
         WHERE organization_id = $1 AND status = 'active' AND deleted_at IS NULL
         ORDER BY full_name, id LIMIT 500`,
        [organizationId],
      ),
    ])
    return {
      professionals: professionals.rows.map((row) => ({ id: row.id, displayName: row.display_name })),
      units: units.rows,
      services: services.rows.map((row) => ({
        id: row.id, name: row.name, durationMinutes: row.duration_minutes,
        defaultCapacity: row.default_capacity,
      })),
      rooms: rooms.rows,
      equipment: equipment.rows,
      clients: clients.rows.map((row) => ({
        id: row.id, fullName: row.full_name, clientType: row.client_type,
      })),
    }
  }

  async #appendScheduleMutation(client, {
    organizationId, actor, appointmentId, action, appointmentType = 'individual', scope = null,
  }) {
    await appendAuditEvent(client, {
      organizationId, actorMembershipId: actor.id, action,
      targetType: 'appointment', targetId: appointmentId,
      minimalMetadata: { appointmentType, ...(scope ? { scope } : {}) },
    })
    await client.query(
      `INSERT INTO outbox_events
        (organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key)
       VALUES ($1, 'appointment', $2, $3, '{}'::jsonb, $4)`,
      [organizationId, appointmentId, action, `${action}:${appointmentId}:${randomUUID()}`],
    )
  }

  async registerPushDevice({ userId, platform, tokenCiphertext, tokenFingerprint }) {
    const result = await this.pool.query(
      `INSERT INTO push_devices
        (user_id, platform, token_ciphertext, token_fingerprint, encryption_version)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (token_fingerprint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           platform = EXCLUDED.platform,
           token_ciphertext = EXCLUDED.token_ciphertext,
           encryption_version = EXCLUDED.encryption_version,
           revoked_at = NULL,
           last_seen_at = now()
       RETURNING id, platform, last_seen_at, created_at`,
      [userId, platform, tokenCiphertext, tokenFingerprint],
    )
    const row = result.rows[0]
    return {
      id: row.id, platform: row.platform, active: true,
      lastSeenAt: row.last_seen_at, createdAt: row.created_at,
    }
  }

  async listPushDevices({ userId }) {
    const result = await this.pool.query(
      `SELECT id, platform, revoked_at, last_seen_at, created_at
       FROM push_devices WHERE user_id = $1 ORDER BY last_seen_at DESC, id`,
      [userId],
    )
    return result.rows.map((row) => ({
      id: row.id, platform: row.platform, active: row.revoked_at === null,
      lastSeenAt: row.last_seen_at, createdAt: row.created_at,
    }))
  }

  async revokePushDevice({ userId, deviceId }) {
    const result = await this.pool.query(
      `UPDATE push_devices SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [deviceId, userId],
    )
    return result.rowCount > 0
  }

  async listNotificationPreferences({ userId, organizationId, eventTypes }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, userId, organizationId)
      const membership = await client.query(
        `SELECT id FROM memberships
         WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
        [organizationId, userId],
      )
      if (!membership.rowCount) return null
      const result = await client.query(
        `SELECT event_type, enabled FROM notification_preferences
         WHERE organization_id = $1 AND user_id = $2 AND channel = 'push'`,
        [organizationId, userId],
      )
      const configured = new Map(result.rows.map((row) => [row.event_type, row.enabled]))
      return eventTypes.map((eventType) => ({ eventType, enabled: configured.get(eventType) ?? true }))
    })
  }

  async updateNotificationPreference({ userId, organizationId, eventType, enabled }) {
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, userId, organizationId)
      const result = await client.query(
        `INSERT INTO notification_preferences
          (organization_id, user_id, channel, event_type, enabled)
         SELECT $1, $2, 'push', $3, $4
         WHERE EXISTS (
           SELECT 1 FROM memberships
           WHERE organization_id = $1 AND user_id = $2 AND status = 'active'
         )
         ON CONFLICT (organization_id, user_id, channel, event_type) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING event_type, enabled, updated_at`,
        [organizationId, userId, eventType, enabled],
      )
      if (!result.rowCount) return null
      return {
        eventType: result.rows[0].event_type,
        enabled: result.rows[0].enabled,
        updatedAt: result.rows[0].updated_at,
      }
    })
  }

  async claimPushOutboxEvents({ workerId, limit }) {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT id FROM outbox_events
         WHERE event_type IN ('waitlist.offer.created', 'billing.reminder')
           AND processed_at IS NULL AND failed_at IS NULL
           AND available_at <= clock_timestamp()
           AND (locked_at IS NULL OR locked_at < clock_timestamp() - interval '2 minutes')
         ORDER BY available_at, created_at, id
         LIMIT $2 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE outbox_events event
         SET locked_at = clock_timestamp(), locked_by = $1, attempt_count = attempt_count + 1
         FROM candidates WHERE event.id = candidates.id
         RETURNING event.id, event.organization_id, event.aggregate_id,
                   event.event_type, event.attempt_count
       )
       SELECT claimed.*,
              COALESCE(waiting_client.user_id, billed_client.user_id) AS recipient_user_id
       FROM claimed
       LEFT JOIN waitlist_offers offer
         ON offer.organization_id = claimed.organization_id
        AND offer.id = claimed.aggregate_id
       LEFT JOIN waitlist_entries entry
         ON entry.organization_id = offer.organization_id
        AND entry.id = offer.waitlist_entry_id
       LEFT JOIN clients waiting_client
         ON waiting_client.organization_id = entry.organization_id
        AND waiting_client.id = entry.client_id
        AND waiting_client.status = 'active' AND waiting_client.deleted_at IS NULL
       LEFT JOIN billing_reminders reminder
         ON reminder.organization_id = claimed.organization_id
        AND reminder.id = claimed.aggregate_id
       LEFT JOIN receivables billed_receivable
         ON billed_receivable.organization_id = reminder.organization_id
        AND billed_receivable.id = reminder.receivable_id
       LEFT JOIN clients billed_client
         ON billed_client.organization_id = billed_receivable.organization_id
        AND billed_client.id = billed_receivable.client_id
        AND billed_client.status = 'active' AND billed_client.deleted_at IS NULL`,
      [workerId, limit],
    )
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      attemptCount: row.attempt_count,
      recipientUserId: row.recipient_user_id,
    }))
  }

  async preparePushDeliveries({ event, templateKey }) {
    if (!event.recipientUserId) return []
    return inTransaction(this.pool, async (client) => {
      await setTenantContext(client, event.recipientUserId, event.organizationId)
      const notification = await client.query(
        `INSERT INTO notifications
          (organization_id, user_id, outbox_event_id, channel, safe_template_key, status)
         SELECT $1, $2, source.id, 'push', $4, 'pending'
         FROM outbox_events source
         WHERE source.organization_id = $1 AND source.id = $3
           AND (
             (source.event_type = 'waitlist.offer.created' AND EXISTS (
               SELECT 1 FROM waitlist_offers active_offer
               WHERE active_offer.organization_id = source.organization_id
                 AND active_offer.id = source.aggregate_id
                 AND active_offer.status = 'active'
                 AND active_offer.expires_at > clock_timestamp()
             ))
             OR
             (source.event_type = 'billing.reminder' AND EXISTS (
               SELECT 1 FROM billing_reminders reminder
               JOIN receivables pending
                 ON pending.organization_id = reminder.organization_id
                AND pending.id = reminder.receivable_id
               JOIN receivable_balances pending_balance
                 ON pending_balance.organization_id = pending.organization_id
                AND pending_balance.receivable_id = pending.id
               WHERE reminder.organization_id = source.organization_id
                 AND reminder.id = source.aggregate_id
                 AND pending.status <> 'cancelled' AND pending_balance.balance_cents > 0
             ))
           )
           AND NOT EXISTS (
             SELECT 1 FROM notification_preferences preference
             WHERE preference.organization_id = $1 AND preference.user_id = $2
               AND preference.channel = 'push'
               AND preference.event_type = source.event_type
               AND NOT preference.enabled
           )
         ON CONFLICT (organization_id, outbox_event_id, user_id, channel) DO UPDATE
         SET updated_at = now()
         RETURNING id`,
        [event.organizationId, event.recipientUserId, event.id, templateKey],
      )
      if (!notification.rowCount) {
        await client.query(
          `UPDATE push_deliveries delivery SET status = 'cancelled', updated_at = now()
           FROM notifications notification
           WHERE notification.organization_id = $1 AND notification.outbox_event_id = $2
             AND notification.user_id = $3 AND notification.channel = 'push'
             AND delivery.organization_id = notification.organization_id
             AND delivery.notification_id = notification.id AND delivery.status = 'pending'`,
          [event.organizationId, event.id, event.recipientUserId],
        )
        await client.query(
          `UPDATE notifications SET status = 'cancelled', updated_at = now()
           WHERE organization_id = $1 AND outbox_event_id = $2 AND user_id = $3
             AND channel = 'push' AND status = 'pending'`,
          [event.organizationId, event.id, event.recipientUserId],
        )
        return []
      }
      const notificationId = notification.rows[0].id
      await client.query(
        `INSERT INTO push_deliveries
          (organization_id, notification_id, push_device_id)
         SELECT $1, $2, device.id FROM push_devices device
         WHERE device.user_id = $3 AND device.revoked_at IS NULL
         ON CONFLICT (organization_id, notification_id, push_device_id) DO NOTHING`,
        [event.organizationId, notificationId, event.recipientUserId],
      )
      const deliveries = await client.query(
        `SELECT delivery.id, delivery.push_device_id, device.token_ciphertext
         FROM push_deliveries delivery
         JOIN push_devices device ON device.id = delivery.push_device_id
         WHERE delivery.organization_id = $1 AND delivery.notification_id = $2
           AND delivery.status = 'pending' AND delivery.available_at <= clock_timestamp()
           AND device.revoked_at IS NULL
         ORDER BY delivery.created_at, delivery.id`,
        [event.organizationId, notificationId],
      )
      if (!deliveries.rowCount) {
        await client.query(
          `UPDATE notifications notification SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM push_deliveries delivery
               WHERE delivery.organization_id = notification.organization_id
                 AND delivery.notification_id = notification.id AND delivery.status = 'sent'
             ) THEN 'sent' ELSE 'cancelled' END,
             updated_at = now()
           WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
          [event.organizationId, notificationId],
        )
      }
      return deliveries.rows.map((row) => ({
        id: row.id, deviceId: row.push_device_id, tokenCiphertext: row.token_ciphertext,
      }))
    })
  }

  async markPushDeliverySent({ event, deliveryId, messageId }) {
    await inTransaction(this.pool, async (client) => {
      await setTenantContext(client, event.recipientUserId, event.organizationId)
      const delivery = await client.query(
        `UPDATE push_deliveries
         SET status = 'sent', attempt_count = attempt_count + 1,
             provider_message_id = $3, delivered_at = now(), updated_at = now(),
             last_error_code = NULL
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         RETURNING notification_id`,
        [event.organizationId, deliveryId, messageId],
      )
      if (delivery.rowCount) {
        await client.query(
          `UPDATE notifications SET status = 'sent', delivered_at = COALESCE(delivered_at, now()),
             updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [event.organizationId, delivery.rows[0].notification_id],
        )
      }
    })
  }

  async markPushDeliveryFailed({ event, deliveryId, deviceId, errorCode, retryable, revokeDevice }) {
    await inTransaction(this.pool, async (client) => {
      await setTenantContext(client, event.recipientUserId, event.organizationId)
      if (revokeDevice) {
        await client.query(
          `UPDATE push_devices SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1 AND user_id = $2`,
          [deviceId, event.recipientUserId],
        )
      }
      const delivery = await client.query(
        `UPDATE push_deliveries
         SET status = CASE WHEN $4::boolean THEN 'pending' WHEN $5::boolean THEN 'cancelled' ELSE 'failed' END,
             attempt_count = attempt_count + 1,
             available_at = CASE WHEN $4::boolean
               THEN clock_timestamp() + LEAST(300, power(2, attempt_count + 1)) * interval '1 second'
               ELSE available_at END,
             last_error_code = $3, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         RETURNING notification_id`,
        [event.organizationId, deliveryId, errorCode, retryable, revokeDevice],
      )
      if (delivery.rowCount && !retryable) {
        await client.query(
          `UPDATE notifications notification
           SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM push_deliveries sent
               WHERE sent.organization_id = notification.organization_id
                 AND sent.notification_id = notification.id AND sent.status = 'sent'
             ) THEN 'sent'
             WHEN $3::boolean THEN 'cancelled' ELSE 'failed' END,
             updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [event.organizationId, delivery.rows[0].notification_id, revokeDevice],
        )
      }
    })
  }

  async finishPushOutboxEvent({ eventId, workerId }) {
    await this.pool.query(
      `UPDATE outbox_events
       SET processed_at = COALESCE(processed_at, now()), locked_at = NULL, locked_by = NULL,
           last_error_code = NULL
       WHERE id = $1 AND locked_by = $2 AND processed_at IS NULL`,
      [eventId, workerId],
    )
  }

  async retryPushOutboxEvent({ eventId, workerId, attemptCount, errorCode }) {
    const seconds = Math.min(300, 2 ** Math.max(1, attemptCount))
    await this.pool.query(
      `UPDATE outbox_events
       SET available_at = clock_timestamp() + $3::integer * interval '1 second',
           locked_at = NULL, locked_by = NULL, last_error_code = $4
       WHERE id = $1 AND locked_by = $2 AND processed_at IS NULL`,
      [eventId, workerId, seconds, errorCode],
    )
  }

  async failPushOutboxEvent({ eventId, workerId, errorCode }) {
    await this.pool.query(
      `UPDATE outbox_events
       SET failed_at = now(), locked_at = NULL, locked_by = NULL, last_error_code = $3
       WHERE id = $1 AND locked_by = $2 AND processed_at IS NULL`,
      [eventId, workerId, errorCode],
    )
  }

  async listAuditEvents({
    actorUserId,
    organizationId,
    limit,
    action = null,
    targetType = null,
    targetId = null,
    cursor = null,
  }) {
    await this.#requirePermission(this.pool, actorUserId, organizationId, 'audit.read')
    const result = await this.pool.query(
      `SELECT event.id, event.actor_membership_id, event.action, event.target_type,
              event.target_id, event.minimal_metadata, event.occurred_at
       FROM audit_events event
       WHERE event.organization_id = $1
         AND EXISTS (
           SELECT 1 FROM memberships actor
           JOIN roles actor_role
             ON actor_role.organization_id = actor.organization_id AND actor_role.id = actor.role_id
           JOIN role_permissions actor_grant
             ON actor_grant.organization_id = actor_role.organization_id
            AND actor_grant.role_id = actor_role.id
           JOIN permissions actor_permission ON actor_permission.id = actor_grant.permission_id
           WHERE actor.user_id = $8 AND actor.organization_id = event.organization_id
             AND actor.status = 'active' AND actor_permission.code = 'audit.read'
         )
         AND ($3::text IS NULL OR event.action = $3)
         AND ($4::text IS NULL OR event.target_type = $4)
         AND ($5::uuid IS NULL OR event.target_id = $5)
         AND ($6::timestamptz IS NULL OR (event.occurred_at, event.id) < ($6::timestamptz, $7::uuid))
       ORDER BY event.occurred_at DESC, event.id DESC
       LIMIT $2`,
      [
        organizationId,
        limit + 1,
        action,
        targetType,
        targetId,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        actorUserId,
      ],
    )
    const hasMore = result.rows.length > limit
    const rows = result.rows.slice(0, limit)
    return {
      events: rows.map((event) => ({
        id: event.id,
        actorMembershipId: event.actor_membership_id,
        action: event.action,
        targetType: event.target_type,
        targetId: event.target_id,
        minimalMetadata: event.minimal_metadata,
        occurredAt: event.occurred_at,
      })),
      next: hasMore && rows.length
        ? { id: rows.at(-1).id, occurredAt: rows.at(-1).occurred_at }
        : null,
    }
  }
}
