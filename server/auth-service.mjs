import {
  createOpaqueToken,
  createRecoveryCodes,
  createTotpSecret,
  createTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  hashRecoveryCode,
  hashPassword,
  hashToken,
  normalizeEmail,
  normalizeRecoveryCode,
  parseMfaEncryptionKey,
  validateEmail,
  validatePassword,
  verifyTotpCode,
  verifyPasswordWithoutEnumeration,
} from './security.mjs'
import { parsePushEncryptionKey, PushTokenCipher } from './push-service.mjs'

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ServiceError'
    this.status = status
    this.code = code
  }
}

const genericCredentialsMessage = 'E-mail ou senha inválidos.'
const genericRegistrationMessage = 'Não foi possível concluir o cadastro com os dados informados.'
const genericMfaMessage = 'O desafio ou código de verificação é inválido ou expirou.'
const auditNamePattern = /^[a-z][a-z0-9_.-]*$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const clientContactTypes = new Set(['email', 'phone', 'other'])
const prospectStages = new Set(['new', 'contacted', 'qualified', 'proposal', 'lost'])
const prospectInteractionTypes = new Set(['call', 'email', 'message', 'meeting', 'note'])
const resourceKinds = new Set(['modalities', 'services', 'rooms', 'equipment'])
const availabilityKinds = new Set(['working_hours', 'break', 'unavailable', 'vacation'])
const pushPlatforms = new Set(['web', 'android'])
const pushEventTypes = Object.freeze(['waitlist.offer.created', 'billing.reminder'])
const receivableStatuses = new Set(['open', 'partially_paid', 'paid', 'overdue', 'cancelled'])
const payableStatuses = new Set(['open', 'partially_paid', 'paid', 'overdue', 'cancelled'])
const financialPaymentMethods = new Set(['pix', 'cash', 'credit_card', 'debit_card', 'transfer', 'boleto', 'other'])

function optionalDate(value, code, message) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ServiceError(400, code, message)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ServiceError(400, code, message)
  }
  return value
}

function requireText(value, maximum = 120) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 && text.length <= maximum ? text : null
}

function normalizeReceivableInput(input, { updating = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_RECEIVABLE', 'Informe os dados válidos da conta a receber.')
  }
  const description = requireText(input.description, 200)
  if (!description || description.length < 2) {
    throw new ServiceError(400, 'INVALID_RECEIVABLE', 'A descrição deve ter entre 2 e 200 caracteres.')
  }
  const amountCents = Number(input.amountCents)
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 999_999_999_99) {
    throw new ServiceError(400, 'INVALID_RECEIVABLE', 'Informe um valor positivo válido em centavos.')
  }
  const dueOn = optionalDate(input.dueOn, 'INVALID_RECEIVABLE', 'Informe um vencimento válido.')
  if (!dueOn) throw new ServiceError(400, 'INVALID_RECEIVABLE', 'Informe um vencimento válido.')
  const competenceOn = optionalDate(
    input.competenceOn, 'INVALID_RECEIVABLE', 'Informe uma competência válida.',
  ) ?? `${dueOn.slice(0, 7)}-01`
  if (!competenceOn.endsWith('-01')) {
    throw new ServiceError(400, 'INVALID_RECEIVABLE', 'A competência deve ser o primeiro dia do mês.')
  }
  const normalized = {
    description,
    clientId: requireUuid(input.clientId, 'INVALID_RECEIVABLE', 'Escolha um cliente válido.'),
    categoryId: requireUuid(input.categoryId, 'INVALID_RECEIVABLE', 'Escolha uma categoria válida.'),
    amountCents,
    currency: 'BRL',
    dueOn,
    competenceOn,
  }
  if (updating) return normalized

  const idempotencyKey = requireText(input.idempotencyKey, 160)
  if (!idempotencyKey || idempotencyKey.length < 8 || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) {
    throw new ServiceError(400, 'INVALID_RECEIVABLE', 'A chave da operação é inválida.')
  }
  let recurrence = null
  if (input.recurrence !== undefined && input.recurrence !== null) {
    const count = Number(input.recurrence.installmentCount)
    if (input.recurrence.frequency !== 'monthly' || !Number.isInteger(count) || count < 2 || count > 60) {
      throw new ServiceError(400, 'INVALID_RECEIVABLE', 'A recorrência mensal deve ter entre 2 e 60 parcelas.')
    }
    recurrence = { frequency: 'monthly', installmentCount: count }
  }
  return { ...normalized, idempotencyKey, recurrence }
}

function normalizeContractBillingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_BILLING_GENERATION', 'Informe os dados da geração contratual.')
  }
  const competenceOn = optionalDate(
    input.competenceOn, 'INVALID_BILLING_GENERATION', 'Informe uma competência válida.',
  )
  const categoryId = requireUuid(
    input.categoryId, 'INVALID_BILLING_GENERATION', 'Escolha uma categoria válida.',
  )
  const contractId = input.contractId === undefined || input.contractId === null || input.contractId === ''
    ? null
    : requireUuid(input.contractId, 'INVALID_BILLING_GENERATION', 'Escolha um contrato válido.')
  const idempotencyKey = requireText(input.idempotencyKey, 160)
  if (!competenceOn?.endsWith('-01') || !idempotencyKey || idempotencyKey.length < 8
    || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) {
    throw new ServiceError(
      400, 'INVALID_BILLING_GENERATION', 'Informe competência e chave válidas para a geração.',
    )
  }
  return { competenceOn, categoryId, contractId, idempotencyKey }
}

const contractStatuses = new Set(['draft', 'active', 'suspended', 'ended', 'cancelled'])

function normalizePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PLAN', 'Informe os dados do plano.')
  }
  const name = requireText(input.name, 120)
  if (!name || name.length < 2) {
    throw new ServiceError(400, 'INVALID_PLAN', 'O nome do plano deve ter entre 2 e 120 caracteres.')
  }
  const priceCents = Number(input.priceCents)
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new ServiceError(400, 'INVALID_PLAN', 'O valor do plano deve ser um número inteiro em centavos maior ou igual a zero.')
  }
  const billingRule = (input.billingRule && typeof input.billingRule === 'object' && !Array.isArray(input.billingRule))
    ? input.billingRule
    : { frequency: 'monthly', dueDay: 10 }
  const active = input.active !== false
  return { name, priceCents, billingRule, active }
}

function normalizeContractInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_CONTRACT', 'Informe os dados do contrato.')
  }
  const planId = requireUuid(input.planId, 'INVALID_CONTRACT', 'Selecione um plano válido.')
  const startsOn = optionalDate(input.startsOn, 'INVALID_CONTRACT', 'Informe a data de início do contrato.')
  if (!startsOn) {
    throw new ServiceError(400, 'INVALID_CONTRACT', 'A data de início do contrato é obrigatória.')
  }
  const endsOn = optionalDate(input.endsOn, 'INVALID_CONTRACT', 'Informe uma data de término válida.')
  if (endsOn && endsOn < startsOn) {
    throw new ServiceError(400, 'INVALID_CONTRACT', 'A data de término não pode ser anterior à data de início.')
  }
  let agreedPriceCents = null
  if (input.agreedPriceCents !== undefined && input.agreedPriceCents !== null && input.agreedPriceCents !== '') {
    const parsed = Number(input.agreedPriceCents)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ServiceError(400, 'INVALID_CONTRACT', 'O valor acordado deve ser um número inteiro em centavos maior ou igual a zero.')
    }
    agreedPriceCents = parsed
  }
  const status = input.status ? String(input.status).trim() : 'active'
  if (!contractStatuses.has(status)) {
    throw new ServiceError(400, 'INVALID_CONTRACT', 'Situação do contrato inválida.')
  }
  return { planId, startsOn, endsOn, agreedPriceCents, status }
}

function normalizeContractPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_CONTRACT', 'Informe os dados para alteração do contrato.')
  }
  const patch = {}
  if (input.status !== undefined) {
    const status = String(input.status).trim()
    if (!contractStatuses.has(status)) {
      throw new ServiceError(400, 'INVALID_CONTRACT', 'Situação do contrato inválida.')
    }
    patch.status = status
  }
  if (input.endsOn !== undefined) {
    patch.endsOn = optionalDate(input.endsOn, 'INVALID_CONTRACT', 'Informe uma data de término válida.')
  }
  if (input.agreedPriceCents !== undefined) {
    const parsed = Number(input.agreedPriceCents)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ServiceError(400, 'INVALID_CONTRACT', 'O valor acordado deve ser um número inteiro em centavos maior ou igual a zero.')
    }
    patch.agreedPriceCents = parsed
  }
  return patch
}

function normalizeFinancialPayment(input, noun = 'pagamento') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PAYMENT', `Informe os dados válidos do ${noun}.`)
  }
  const amountCents = Number(input.amountCents)
  const method = requireText(input.method, 32)
  const paidAt = typeof input.paidAt === 'string' && !Number.isNaN(Date.parse(input.paidAt))
    ? new Date(input.paidAt).toISOString()
    : null
  const idempotencyKey = requireText(input.idempotencyKey, 160)
  const externalReference = input.externalReference === undefined || input.externalReference === null
    || input.externalReference === '' ? null : requireText(input.externalReference, 160)
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 999_999_999_99
    || !method || !financialPaymentMethods.has(method) || !paidAt
    || !idempotencyKey || idempotencyKey.length < 8 || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)
    || (input.externalReference && !externalReference)) {
    throw new ServiceError(400, 'INVALID_PAYMENT', `Informe valor, forma e data válidos para o ${noun}.`)
  }
  return { amountCents, method, paidAt, idempotencyKey, externalReference }
}

function normalizePaymentReversal(input) {
  const reason = requireText(input?.reason, 200)
  const reversedAt = typeof input?.reversedAt === 'string' && !Number.isNaN(Date.parse(input.reversedAt))
    ? new Date(input.reversedAt).toISOString()
    : null
  const idempotencyKey = requireText(input?.idempotencyKey, 160)
  if (!reason || reason.length < 3 || !reversedAt || !idempotencyKey || idempotencyKey.length < 8
    || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) {
    throw new ServiceError(400, 'INVALID_REVERSAL', 'Informe motivo, data e chave válidos para o estorno.')
  }
  return { reason, reversedAt, idempotencyKey }
}

function normalizePayableInput(input, { updating = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PAYABLE', 'Informe os dados válidos da despesa.')
  }
  const description = requireText(input.description, 200)
  const counterparty = requireText(input.counterparty, 160)
  const amountCents = Number(input.amountCents)
  const dueOn = optionalDate(input.dueOn, 'INVALID_PAYABLE', 'Informe um vencimento válido.')
  const competenceOn = optionalDate(
    input.competenceOn, 'INVALID_PAYABLE', 'Informe uma competência válida.',
  ) ?? (dueOn ? `${dueOn.slice(0, 7)}-01` : null)
  if (!description || description.length < 2 || !counterparty || counterparty.length < 2
    || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 999_999_999_99
    || !dueOn || !competenceOn?.endsWith('-01')) {
    throw new ServiceError(400, 'INVALID_PAYABLE', 'Informe fornecedor, descrição, valor e datas válidos.')
  }
  const normalized = {
    description, counterparty,
    categoryId: requireUuid(input.categoryId, 'INVALID_PAYABLE', 'Escolha uma categoria válida.'),
    amountCents, currency: 'BRL', dueOn, competenceOn,
  }
  if (updating) return normalized
  const idempotencyKey = requireText(input.idempotencyKey, 160)
  if (!idempotencyKey || idempotencyKey.length < 8 || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) {
    throw new ServiceError(400, 'INVALID_PAYABLE', 'A chave da operação é inválida.')
  }
  let recurrence = null
  if (input.recurrence !== undefined && input.recurrence !== null) {
    const count = Number(input.recurrence.installmentCount)
    if (input.recurrence.frequency !== 'monthly' || !Number.isInteger(count) || count < 2 || count > 60) {
      throw new ServiceError(400, 'INVALID_PAYABLE', 'A recorrência mensal deve ter entre 2 e 60 parcelas.')
    }
    recurrence = { frequency: 'monthly', installmentCount: count }
  }
  return { ...normalized, idempotencyKey, recurrence }
}

function optionalAuditName(value, maximum) {
  if (value === undefined || value === null || value === '') return null
  const text = requireText(value, maximum)
  if (!text || !auditNamePattern.test(text)) {
    throw new ServiceError(400, 'INVALID_AUDIT_FILTER', 'Filtro de auditoria inválido.')
  }
  return text
}

function parseAuditCursor(value) {
  if (value === undefined || value === null || value === '') return null
  const encoded = requireText(value, 512)
  if (!encoded) throw new ServiceError(400, 'INVALID_AUDIT_CURSOR', 'Cursor de auditoria inválido.')
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || Number.isNaN(Date.parse(decoded[0]))
      || !uuidPattern.test(decoded[1])
    ) {
      throw new Error('invalid cursor')
    }
    return { occurredAt: new Date(decoded[0]), id: decoded[1] }
  } catch {
    throw new ServiceError(400, 'INVALID_AUDIT_CURSOR', 'Cursor de auditoria inválido.')
  }
}

function encodeAuditCursor(cursor) {
  if (!cursor) return null
  return Buffer.from(JSON.stringify([
    new Date(cursor.occurredAt).toISOString(),
    cursor.id,
  ])).toString('base64url')
}

function normalizeClientInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_CLIENT', 'Informe os dados válidos do cliente.')
  }
  const fullName = typeof input.fullName === 'string'
    ? input.fullName.trim().replace(/\s+/gu, ' ')
    : ''
  if (fullName.length < 2 || fullName.length > 120) {
    throw new ServiceError(400, 'INVALID_CLIENT', 'O nome deve ter entre 2 e 120 caracteres.')
  }

  const clientType = input.clientType ?? 'rotating'
  if (clientType !== 'fixed' && clientType !== 'rotating') {
    throw new ServiceError(400, 'INVALID_CLIENT', 'Escolha um tipo de cliente válido.')
  }

  let birthDate = null
  if (input.birthDate !== undefined && input.birthDate !== null && input.birthDate !== '') {
    birthDate = typeof input.birthDate === 'string' ? input.birthDate : ''
    const date = /^\d{4}-\d{2}-\d{2}$/u.test(birthDate)
      ? new Date(`${birthDate}T00:00:00.000Z`)
      : new Date(Number.NaN)
    const today = new Date().toISOString().slice(0, 10)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate
      || birthDate < '1900-01-01' || birthDate > today) {
      throw new ServiceError(400, 'INVALID_CLIENT', 'Informe uma data de nascimento válida.')
    }
  }

  let documentNumber = null
  if (input.documentNumber !== undefined && input.documentNumber !== null && input.documentNumber !== '') {
    documentNumber = typeof input.documentNumber === 'string'
      ? input.documentNumber.toUpperCase().replace(/[^A-Z0-9]/gu, '')
      : ''
    if (documentNumber.length < 5 || documentNumber.length > 32) {
      throw new ServiceError(400, 'INVALID_CLIENT', 'Informe um documento válido, com 5 a 32 caracteres.')
    }
  }

  if (input.contacts !== undefined && !Array.isArray(input.contacts)) {
    throw new ServiceError(400, 'INVALID_CLIENT', 'A lista de contatos é inválida.')
  }
  const contacts = (input.contacts ?? []).map((contact) => {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)
      || !clientContactTypes.has(contact.type)) {
      throw new ServiceError(400, 'INVALID_CLIENT', 'Informe contatos válidos.')
    }
    const value = typeof contact.value === 'string' ? contact.value.trim() : ''
    let normalizedValue
    if (contact.type === 'email') {
      normalizedValue = normalizeEmail(value)
      if (!validateEmail(normalizedValue)) {
        throw new ServiceError(400, 'INVALID_CLIENT', 'Informe um e-mail de contato válido.')
      }
    } else if (contact.type === 'phone') {
      normalizedValue = value.replace(/\D/gu, '')
      if (normalizedValue.length < 10 || normalizedValue.length > 15) {
        throw new ServiceError(400, 'INVALID_CLIENT', 'Informe um telefone com DDD válido.')
      }
    } else {
      normalizedValue = value.toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ')
      if (normalizedValue.length < 3 || normalizedValue.length > 160) {
        throw new ServiceError(400, 'INVALID_CLIENT', 'Informe um contato válido.')
      }
    }
    return {
      type: contact.type,
      value: contact.type === 'email' ? normalizedValue : value.replace(/\s+/gu, ' '),
      normalizedValue,
      preferred: contact.preferred === true,
    }
  })
  if (contacts.length > 10) {
    throw new ServiceError(400, 'INVALID_CLIENT', 'Cadastre no máximo 10 contatos por cliente.')
  }
  const uniqueContacts = new Set()
  const preferredTypes = new Set()
  for (const contact of contacts) {
    const key = `${contact.type}:${contact.normalizedValue}`
    if (uniqueContacts.has(key)) {
      throw new ServiceError(409, 'CLIENT_DUPLICATE', 'O mesmo contato foi informado mais de uma vez.')
    }
    uniqueContacts.add(key)
    if (contact.preferred && preferredTypes.has(contact.type)) {
      throw new ServiceError(400, 'INVALID_CLIENT', 'Escolha somente um contato preferencial de cada tipo.')
    }
    if (contact.preferred) preferredTypes.add(contact.type)
  }
  return { fullName, birthDate, documentNumber, clientType, contacts }
}

function normalizeProspectContacts(input) {
  if (input !== undefined && !Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'A lista de contatos é inválida.')
  }
  const contacts = (input ?? []).map((contact) => {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)
      || !clientContactTypes.has(contact.type)) {
      throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe contatos válidos.')
    }
    const value = typeof contact.value === 'string' ? contact.value.trim() : ''
    let normalizedValue
    if (contact.type === 'email') {
      normalizedValue = normalizeEmail(value)
      if (!validateEmail(normalizedValue)) {
        throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe um e-mail de contato válido.')
      }
    } else if (contact.type === 'phone') {
      normalizedValue = value.replace(/\D/gu, '')
      if (normalizedValue.length < 10 || normalizedValue.length > 15) {
        throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe um telefone com DDD válido.')
      }
    } else {
      normalizedValue = value.toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ')
      if (normalizedValue.length < 3 || normalizedValue.length > 160) {
        throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe um contato válido.')
      }
    }
    return {
      type: contact.type,
      value: contact.type === 'email' ? normalizedValue : value.replace(/\s+/gu, ' '),
      normalizedValue,
      preferred: contact.preferred === true,
    }
  })
  if (contacts.length > 10) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Cadastre no máximo 10 contatos por prospecção.')
  }
  const uniqueContacts = new Set()
  const preferredTypes = new Set()
  for (const contact of contacts) {
    const key = `${contact.type}:${contact.normalizedValue}`
    if (uniqueContacts.has(key)) {
      throw new ServiceError(409, 'PROSPECT_DUPLICATE_CONTACT', 'O mesmo contato foi informado mais de uma vez.')
    }
    uniqueContacts.add(key)
    if (contact.preferred && preferredTypes.has(contact.type)) {
      throw new ServiceError(400, 'INVALID_PROSPECT', 'Escolha somente um contato preferencial de cada tipo.')
    }
    if (contact.preferred) preferredTypes.add(contact.type)
  }
  return contacts
}

function normalizeProspectInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe os dados válidos da prospecção.')
  }
  const fullName = typeof input.fullName === 'string'
    ? input.fullName.trim().replace(/\s+/gu, ' ')
    : ''
  const source = typeof input.source === 'string'
    ? input.source.trim().replace(/\s+/gu, ' ')
    : ''
  const stage = input.stage ?? 'new'
  const ownerProfessionalId = input.ownerProfessionalId === undefined
    || input.ownerProfessionalId === null || input.ownerProfessionalId === ''
    ? null
    : input.ownerProfessionalId
  if (fullName.length < 2 || fullName.length > 120) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'O nome deve ter entre 2 e 120 caracteres.')
  }
  if (source.length < 2 || source.length > 80 || !prospectStages.has(stage)) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe uma origem e uma etapa válidas.')
  }
  if (ownerProfessionalId !== null && (typeof ownerProfessionalId !== 'string'
    || !uuidPattern.test(ownerProfessionalId))) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Escolha um responsável válido.')
  }

  let nextActionAt = null
  if (input.nextActionAt !== undefined && input.nextActionAt !== null && input.nextActionAt !== '') {
    const parsed = typeof input.nextActionAt === 'string' ? new Date(input.nextActionAt) : new Date(Number.NaN)
    if (Number.isNaN(parsed.getTime())) {
      throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe uma data válida para a próxima ação.')
    }
    nextActionAt = parsed
  }
  const nextActionNote = input.nextActionNote === undefined || input.nextActionNote === null
    || input.nextActionNote === ''
    ? null
    : typeof input.nextActionNote === 'string'
      ? input.nextActionNote.trim().replace(/\s+/gu, ' ')
      : ''
  if (nextActionNote !== null && (nextActionNote.length < 2 || nextActionNote.length > 240)) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Descreva a próxima ação em até 240 caracteres.')
  }
  if ((nextActionAt === null) !== (nextActionNote === null)) {
    throw new ServiceError(400, 'INVALID_PROSPECT', 'Informe a descrição e a data da próxima ação.')
  }
  return {
    fullName, source, stage, ownerProfessionalId, nextActionAt, nextActionNote,
    contacts: normalizeProspectContacts(input.contacts),
  }
}

function normalizeProspectInteraction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !prospectInteractionTypes.has(input.type)) {
    throw new ServiceError(400, 'INVALID_PROSPECT_INTERACTION', 'Escolha um tipo de contato válido.')
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim() : ''
  if (notes.length < 2 || notes.length > 2000) {
    throw new ServiceError(400, 'INVALID_PROSPECT_INTERACTION', 'Descreva o contato em até 2.000 caracteres.')
  }
  const occurredAt = input.occurredAt === undefined || input.occurredAt === null || input.occurredAt === ''
    ? new Date()
    : new Date(typeof input.occurredAt === 'string' ? input.occurredAt : Number.NaN)
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ServiceError(400, 'INVALID_PROSPECT_INTERACTION', 'Informe uma data válida para o contato.')
  }
  return { type: input.type, notes, occurredAt }
}

function normalizeProspectConversion(input) {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_PROSPECT_CONVERSION', 'Informe dados válidos para a conversão.')
  }
  const normalized = normalizeClientInput({
    fullName: 'Prospecção', contacts: [], clientType: input.clientType,
    birthDate: input.birthDate, documentNumber: input.documentNumber,
  })
  return {
    clientType: normalized.clientType,
    birthDate: normalized.birthDate,
    documentNumber: normalized.documentNumber,
  }
}

function normalizeResourceKind(kind) {
  if (!resourceKinds.has(kind)) {
    throw new ServiceError(404, 'RESOURCE_KIND_NOT_FOUND', 'Tipo de recurso não encontrado.')
  }
  return kind
}

function normalizeResourceInput(kind, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_RESOURCE', 'Informe os dados válidos do recurso.')
  }
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/gu, ' ') : ''
  if (name.length < 2 || name.length > 120) {
    throw new ServiceError(400, 'INVALID_RESOURCE', 'O nome deve ter entre 2 e 120 caracteres.')
  }
  const active = input.active === undefined ? true : input.active
  if (typeof active !== 'boolean') {
    throw new ServiceError(400, 'INVALID_RESOURCE', 'A situação do recurso é inválida.')
  }
  const normalized = { name, active }
  if (kind === 'services') {
    if (!uuidPattern.test(input.modalityId ?? '')) {
      throw new ServiceError(400, 'INVALID_RESOURCE_REFERENCE', 'Escolha uma modalidade válida.')
    }
    const durationMinutes = Number(input.durationMinutes)
    const defaultCapacity = Number(input.defaultCapacity)
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440
      || !Number.isInteger(defaultCapacity) || defaultCapacity < 1 || defaultCapacity > 10000) {
      throw new ServiceError(400, 'INVALID_RESOURCE', 'Duração ou capacidade do serviço inválida.')
    }
    return { ...normalized, modalityId: input.modalityId, durationMinutes, defaultCapacity }
  }
  if (kind === 'rooms' || kind === 'equipment') {
    if (!uuidPattern.test(input.unitId ?? '')) {
      throw new ServiceError(400, 'INVALID_RESOURCE_REFERENCE', 'Escolha uma unidade válida.')
    }
    const quantityField = kind === 'rooms' ? 'capacity' : 'quantity'
    const quantity = Number(input[quantityField])
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      throw new ServiceError(400, 'INVALID_RESOURCE', 'Capacidade ou quantidade inválida.')
    }
    return { ...normalized, unitId: input.unitId, [quantityField]: quantity }
  }
  return normalized
}

function requireUuid(value, code, message) {
  if (!uuidPattern.test(value ?? '')) throw new ServiceError(400, code, message)
  return value
}

function parseZonedInstant(value, code, message) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new ServiceError(400, code, message)
  }
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) throw new ServiceError(400, code, message)
  return instant
}

function normalizeTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/u.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour <= 23 && minute <= 59 ? value : null
}

function normalizeAvailabilityInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !availabilityKinds.has(input.kind)) {
    throw new ServiceError(400, 'INVALID_AVAILABILITY', 'Informe uma regra de disponibilidade válida.')
  }
  const professionalId = requireUuid(
    input.professionalId, 'INVALID_AVAILABILITY_REFERENCE', 'Escolha um profissional válido.',
  )
  const unitId = requireUuid(
    input.unitId, 'INVALID_AVAILABILITY_REFERENCE', 'Escolha uma unidade válida.',
  )
  const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : 'America/Sao_Paulo'
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(new Date(0))
  } catch {
    throw new ServiceError(400, 'INVALID_AVAILABILITY', 'Informe um fuso horário IANA válido.')
  }
  const label = input.label === undefined || input.label === null || input.label === ''
    ? null : requireText(input.label, 120)
  if (input.label && (!label || label.length < 2)) {
    throw new ServiceError(400, 'INVALID_AVAILABILITY', 'A descrição deve ter entre 2 e 120 caracteres.')
  }
  const active = input.active === undefined ? true : input.active
  if (typeof active !== 'boolean') {
    throw new ServiceError(400, 'INVALID_AVAILABILITY', 'A situação da regra é inválida.')
  }

  if (input.kind === 'working_hours' || input.kind === 'break') {
    const weekday = Number(input.weekday)
    const localStartTime = normalizeTime(input.localStartTime)
    const localEndTime = normalizeTime(input.localEndTime)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7
      || !localStartTime || !localEndTime || localEndTime <= localStartTime) {
      throw new ServiceError(400, 'INVALID_AVAILABILITY', 'Informe dia e intervalo semanal válidos.')
    }
    return {
      kind: input.kind, professionalId, unitId, timezone, label, active,
      weekday, localStartTime, localEndTime, startsAt: null, endsAt: null,
    }
  }

  const startsAt = parseZonedInstant(
    input.startsAt, 'INVALID_AVAILABILITY', 'Informe início e fim com fuso horário explícito.',
  )
  const endsAt = parseZonedInstant(
    input.endsAt, 'INVALID_AVAILABILITY', 'Informe início e fim com fuso horário explícito.',
  )
  if (endsAt <= startsAt) {
    throw new ServiceError(400, 'INVALID_AVAILABILITY', 'O fim da indisponibilidade deve ser posterior ao início.')
  }
  return {
    kind: input.kind, professionalId, unitId, timezone, label, active,
    weekday: null, localStartTime: null, localEndTime: null, startsAt, endsAt,
  }
}

function normalizeAppointmentBase(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'INVALID_APPOINTMENT', 'Informe os dados válidos do agendamento.')
  }
  const requestedEquipment = input.equipment ?? []
  if (!Array.isArray(requestedEquipment) || requestedEquipment.length > 100) {
    throw new ServiceError(400, 'INVALID_APPOINTMENT_EQUIPMENT', 'Informe aparelhos válidos para o agendamento.')
  }
  const equipment = requestedEquipment.map((item) => {
    const equipmentId = requireUuid(
      item?.equipmentId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha um aparelho válido.',
    )
    const quantity = Number(item?.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      throw new ServiceError(400, 'INVALID_APPOINTMENT_EQUIPMENT', 'Informe uma quantidade válida de aparelhos.')
    }
    return { equipmentId, quantity }
  })
  if (new Set(equipment.map(({ equipmentId }) => equipmentId)).size !== equipment.length) {
    throw new ServiceError(400, 'INVALID_APPOINTMENT_EQUIPMENT', 'Não repita o mesmo aparelho no agendamento.')
  }
  return {
    professionalId: requireUuid(
      input.professionalId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha um profissional válido.',
    ),
    unitId: requireUuid(input.unitId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha uma unidade válida.'),
    serviceId: requireUuid(input.serviceId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha um serviço válido.'),
    roomId: input.roomId === undefined || input.roomId === null || input.roomId === '' ? null
      : requireUuid(input.roomId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha uma sala válida.'),
    startsAt: parseZonedInstant(
      input.startsAt, 'INVALID_APPOINTMENT', 'Informe data e horário com fuso explícito.',
    ),
    equipment,
  }
}

function normalizeParticipantStatusInput(input) {
  const allowed = new Set(['confirmed', 'attended', 'absent', 'cancelled'])
  if (!input || typeof input !== 'object' || Array.isArray(input) || !allowed.has(input.status)) {
    throw new ServiceError(400, 'INVALID_PARTICIPANT_STATUS', 'Escolha um estado válido para a participação.')
  }
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
  if (reason && (reason.length < 2 || reason.length > 500)) {
    throw new ServiceError(400, 'INVALID_PARTICIPANT_STATUS', 'O motivo deve ter entre 2 e 500 caracteres.')
  }
  return { status: input.status, reason: input.status === 'cancelled' ? reason : null }
}

function normalizeAppointmentInput(input) {
  return {
    ...normalizeAppointmentBase(input),
    clientId: requireUuid(input.clientId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha um cliente válido.'),
  }
}

function normalizeClassAppointmentInput(input) {
  const base = normalizeAppointmentBase(input)
  const capacity = Number(input.capacity)
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 10000) {
    throw new ServiceError(400, 'INVALID_CLASS_CAPACITY', 'Informe uma capacidade válida para a turma.')
  }
  const clientIds = input.clientIds === undefined ? [] : input.clientIds
  if (!Array.isArray(clientIds) || clientIds.length > capacity) {
    throw new ServiceError(400, 'INVALID_CLASS_PARTICIPANTS', 'Os participantes excedem a capacidade da turma.')
  }
  const uniqueClientIds = [...new Set(clientIds.map((clientId) => requireUuid(
    clientId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha clientes válidos.',
  )))]
  if (uniqueClientIds.length !== clientIds.length) {
    throw new ServiceError(400, 'INVALID_CLASS_PARTICIPANTS', 'Não repita clientes na mesma turma.')
  }
  return { ...base, capacity, clientIds: uniqueClientIds }
}

function zonedParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]))
}

function localDateTimeToInstant(parts, timezone) {
  const localMilliseconds = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  )
  let guess = localMilliseconds
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(guess), timezone)
    const represented = Date.UTC(
      actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second,
    )
    guess = localMilliseconds - (represented - guess)
  }
  return new Date(guess)
}

function localDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function normalizeAppointmentSeriesInput(input) {
  const appointment = normalizeAppointmentInput(input)
  const recurrence = input?.recurrence
  if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)
    || (recurrence.frequency ?? 'weekly') !== 'weekly') {
    throw new ServiceError(400, 'INVALID_RECURRENCE', 'Informe uma recorrência semanal válida.')
  }
  const interval = Number(recurrence.interval ?? 1)
  const count = Number(recurrence.count)
  const timezone = typeof recurrence.timezone === 'string'
    ? recurrence.timezone.trim() : 'America/Sao_Paulo'
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(new Date(0))
  } catch {
    throw new ServiceError(400, 'INVALID_RECURRENCE', 'Informe um fuso horário IANA válido.')
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 52
    || !Number.isInteger(count) || count < 2 || count > 104) {
    throw new ServiceError(400, 'INVALID_RECURRENCE', 'A série deve ter de 2 a 104 ocorrências.')
  }
  const first = zonedParts(appointment.startsAt, timezone)
  const occurrences = Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + index * interval * 7))
    return localDateTimeToInstant({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: first.hour, minute: first.minute, second: first.second,
    }, timezone)
  })
  return {
    ...appointment,
    timezone,
    interval,
    occurrences,
    seriesStart: localDate(first),
    seriesEnd: localDate(zonedParts(occurrences.at(-1), timezone)),
    recurrenceExpression: `FREQ=WEEKLY;INTERVAL=${interval};COUNT=${count}`,
  }
}

function normalizeScheduleRange(input) {
  const from = parseZonedInstant(
    input.from, 'INVALID_SCHEDULE_RANGE', 'Informe um período válido para consultar a agenda.',
  )
  const to = parseZonedInstant(
    input.to, 'INVALID_SCHEDULE_RANGE', 'Informe um período válido para consultar a agenda.',
  )
  if (to <= from || to.getTime() - from.getTime() > 93 * 24 * 60 * 60 * 1000) {
    throw new ServiceError(400, 'INVALID_SCHEDULE_RANGE', 'Consulte um período de até 93 dias.')
  }
  const professionalId = input.professionalId
    ? requireUuid(input.professionalId, 'INVALID_SCHEDULE_RANGE', 'Escolha um profissional válido.')
    : null
  return { from, to, professionalId }
}

function normalizeReportFilters(input = {}, { exporting = false } = {}) {
  const from = optionalDate(
    input.from, 'INVALID_REPORT_FILTER', 'Informe um período válido para o relatório.',
  )
  const to = optionalDate(
    input.to, 'INVALID_REPORT_FILTER', 'Informe um período válido para o relatório.',
  )
  const fromInstant = from ? new Date(`${from}T00:00:00.000Z`) : null
  const toInstant = to ? new Date(`${to}T00:00:00.000Z`) : null
  if (!from || !to || to < from
    || toInstant.getTime() - fromInstant.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new ServiceError(
      400, 'INVALID_REPORT_FILTER', 'Informe um período de até 367 dias para o relatório.',
    )
  }
  const unitId = input.unitId
    ? requireUuid(input.unitId, 'INVALID_REPORT_FILTER', 'Escolha uma unidade válida.')
    : null
  const professionalId = input.professionalId
    ? requireUuid(input.professionalId, 'INVALID_REPORT_FILTER', 'Escolha um profissional válido.')
    : null
  const status = input.status === undefined || input.status === '' ? null : input.status
  if (status !== null && status !== 'active' && status !== 'inactive') {
    throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'Escolha uma situação válida.')
  }
  const page = exporting ? 1 : input.page === undefined || input.page === '' ? 1 : Number(input.page)
  const pageSize = exporting
    ? 10_001
    : input.pageSize === undefined || input.pageSize === '' ? 25 : Number(input.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 10_000
    || !Number.isInteger(pageSize) || pageSize < 1 || (!exporting && pageSize > 100)) {
    throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'Paginação do relatório inválida.')
  }
  return { from, to, unitId, professionalId, status, page, pageSize }
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function birthdayReportCsv(items) {
  const header = ['Data', 'Cliente', 'Situação', 'Contato autorizado', 'Tipo de contato', 'Contato']
  const rows = items.map((item) => [
    item.occursOn,
    item.fullName,
    item.status === 'active' ? 'Ativo' : 'Inativo',
    item.contactAllowed ? 'Sim' : 'Não',
    item.preferredContact?.type ?? '',
    item.preferredContact?.value ?? '',
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function normalizeClientReportFilters(input = {}, options = {}) {
  const filters = normalizeReportFilters(input, options)
  const clientType = input.clientType === undefined || input.clientType === ''
    ? 'all'
    : input.clientType
  if (clientType !== 'all' && clientType !== 'fixed') {
    throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'Escolha uma visão de clientes válida.')
  }
  return { ...filters, clientType }
}

function normalizeActivityReportFilters(input = {}, options = {}) {
  const filters = normalizeReportFilters(input, options)
  const granularity = input.granularity === undefined || input.granularity === ''
    ? 'month'
    : input.granularity
  if (granularity !== 'month' && granularity !== 'year') {
    throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'Escolha um agrupamento válido.')
  }
  const bucket = input.bucket === undefined || input.bucket === '' ? null : input.bucket
  const bucketPattern = granularity === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/u : /^\d{4}$/u
  if (bucket !== null && (typeof bucket !== 'string' || !bucketPattern.test(bucket))) {
    throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'Escolha um período válido para detalhar.')
  }
  if (bucket !== null) {
    const bucketStart = granularity === 'month' ? `${bucket}-01` : `${bucket}-01-01`
    const bucketEnd = granularity === 'month'
      ? new Date(Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)), 0))
        .toISOString().slice(0, 10)
      : `${bucket}-12-31`
    if (bucketEnd < filters.from || bucketStart > filters.to) {
      throw new ServiceError(400, 'INVALID_REPORT_FILTER', 'O detalhamento está fora do período filtrado.')
    }
  }
  return { ...filters, granularity, bucket }
}

function normalizeEquipmentUsageReportFilters(input = {}, options = {}) {
  const filters = normalizeReportFilters(input, options)
  const modalityId = input.modalityId === undefined || input.modalityId === ''
    ? null
    : requireUuid(input.modalityId, 'INVALID_REPORT_FILTER', 'Escolha uma modalidade válida.')
  return { ...filters, modalityId }
}

function clientReportCsv(items) {
  const header = ['Cadastro', 'Cliente', 'Tipo', 'Situação', 'Plano fixo', 'Início do plano', 'Fim do plano']
  const rows = items.map((item) => [
    item.registeredOn,
    item.fullName,
    item.clientType === 'fixed' ? 'Fixo' : 'Rotativo',
    item.status === 'active' ? 'Ativo' : 'Inativo',
    item.plan?.name ?? '',
    item.plan?.startsOn ?? '',
    item.plan?.endsOn ?? '',
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function clientActivityReportCsv(result, bucket) {
  const header = bucket
    ? ['Última presença', 'Cliente', 'Tipo', 'Situação', 'Presenças']
    : ['Período', 'Início', 'Fim', 'Clientes ativos', 'Presenças']
  const rows = bucket
    ? result.details.map((item) => [
      item.lastAttendanceOn,
      item.fullName,
      item.clientType === 'fixed' ? 'Fixo' : 'Rotativo',
      item.status === 'active' ? 'Ativo' : 'Inativo',
      item.attendances,
    ])
    : result.items.map((item) => [
      item.period, item.periodStart, item.periodEnd, item.activeClients, item.attendances,
    ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function businessDashboardReportCsv(result) {
  const header = ['Grupo', 'Indicador', 'Valor', 'Unidade']
  const rows = [
    ['Financeiro', 'Faturado', result.financial.billedCents, 'centavos'],
    ['Financeiro', 'Recebido líquido', result.financial.receivedCents, 'centavos'],
    ['Financeiro', 'Saldo em aberto', result.financial.outstandingCents, 'centavos'],
    ['Operacional', 'Agendamentos', result.operational.appointments, 'quantidade'],
    ['Operacional', 'Agendamentos realizados', result.operational.completedAppointments, 'quantidade'],
    ['Operacional', 'Presenças', result.operational.attendances, 'quantidade'],
    ['Operacional', 'Faltas', result.operational.absences, 'quantidade'],
    ['Operacional', 'Taxa de presença', result.operational.attendanceRate, 'percentual'],
  ]
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function equipmentUsageReportCsv(items) {
  const header = [
    'Aparelho', 'Unidade', 'Modalidade', 'Agendamentos realizados',
    'Quantidade alocada', 'Presenças', 'Último uso',
  ]
  const rows = items.map((item) => [
    item.equipmentName,
    item.unitName,
    item.modalityName,
    item.appointments,
    item.allocatedQuantity,
    item.attendances,
    item.lastUsedOn,
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function prospectReportCsv(items) {
  const stageLabels = {
    new: 'Nova', contacted: 'Contatada', qualified: 'Qualificada', proposal: 'Proposta',
    lost: 'Perdida', converted: 'Convertida',
  }
  const header = [
    'Cadastro', 'Prospecção', 'Origem', 'Etapa', 'Responsável',
    'Desfecho', 'Tempo de ciclo (dias)',
  ]
  const rows = items.map((item) => [
    item.createdOn,
    item.fullName,
    item.source,
    stageLabels[item.stage] ?? item.stage,
    item.ownerDisplayName ?? '',
    item.closedOn ?? '',
    item.cycleDays ?? '',
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`
}

export class AuthService {
  constructor(repository, options = {}) {
    this.repository = repository
    this.notifyPasswordReset = options.notifyPasswordReset ?? (async () => {})
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? 8 * 60 * 60 * 1000
    this.resetLifetimeMs = options.resetLifetimeMs ?? 30 * 60 * 1000
    this.mfaChallengeLifetimeMs = options.mfaChallengeLifetimeMs ?? 5 * 60 * 1000
    this.mfaEncryptionKey = Buffer.isBuffer(options.mfaEncryptionKey)
      ? Buffer.from(options.mfaEncryptionKey)
      : parseMfaEncryptionKey(options.mfaEncryptionKey)
    if (this.mfaEncryptionKey.length !== 32) {
      throw new Error('A chave de criptografia MFA deve conter exatamente 32 bytes.')
    }
    const pushEncryptionKey = options.pushTokenEncryptionKey === undefined
      ? this.mfaEncryptionKey
      : Buffer.isBuffer(options.pushTokenEncryptionKey)
        ? Buffer.from(options.pushTokenEncryptionKey)
        : parsePushEncryptionKey(options.pushTokenEncryptionKey)
    this.pushTokenCipher = options.pushTokenCipher ?? new PushTokenCipher(pushEncryptionKey)
  }

  async register(input) {
    const inviteToken = typeof input?.inviteToken === 'string' ? input.inviteToken.trim() : null
    if (!inviteToken) {
      throw new ServiceError(403, 'INVITE_REQUIRED', 'O cadastro no sistema é permitido apenas mediante convite de uma companhia.')
    }

    if (!validatePassword(input?.password)) {
      throw new ServiceError(400, 'INVALID_PASSWORD', 'A senha deve ter entre 12 e 128 caracteres.')
    }

    const email = input?.email ? normalizeEmail(input.email) : null
    if (email && !validateEmail(email)) {
      throw new ServiceError(400, 'INVALID_EMAIL', 'E-mail inválido.')
    }

    const passwordHash = await hashPassword(input.password)
    try {
      const account = await this.repository.registerAccountViaInvite({
        inviteTokenHash: hashToken(inviteToken),
        email,
        passwordHash,
      })

      return { status: 'authenticated', ...(await this.#newSession(account.userId, account.organizationId)) }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error?.code === '23505' || error?.code === 'ACCOUNT_EXISTS') {
        throw new ServiceError(400, 'INVALID_REGISTRATION', 'Já existe uma conta ativa para este e-mail.')
      }
      throw error
    }
  }

  async lookupInvitation(rawToken) {
    const token = requireText(rawToken, 256)
    if (!token) throw new ServiceError(400, 'INVALID_TOKEN', 'Token de convite não informado.')
    const invitation = await this.repository.getInvitationByToken(hashToken(token))
    if (!invitation) {
      throw new ServiceError(404, 'INVITATION_NOT_FOUND', 'Convite inválido, cancelado ou expirado.')
    }
    return {
      valid: true,
      organizationName: invitation.organization_name,
      roleName: invitation.role_name,
      roleCode: invitation.role_code,
      email: invitation.email_normalized,
      expiresAt: invitation.expires_at,
    }
  }

  async login(input) {
    const email = normalizeEmail(input?.email)
    const credential = validateEmail(email)
      ? await this.repository.findCredentialByEmail(email)
      : null
    const matches = await verifyPasswordWithoutEnumeration(
      typeof input?.password === 'string' ? input.password : '',
      credential?.passwordHash,
    )

    if (!matches || credential?.status !== 'active') {
      throw new ServiceError(401, 'INVALID_CREDENTIALS', genericCredentialsMessage)
    }

    if (credential.requiresMfa) {
      return this.#startMfaChallenge({
        userId: credential.userId,
        email,
        organizationId: credential.organizationId,
        enrolled: credential.mfaEnrolled,
      })
    }

    return { status: 'authenticated', ...(await this.#newSession(credential.userId, credential.organizationId)) }
  }

  async verifyMfa(input) {
    const challengeToken = requireText(input?.challengeToken, 256)
    const submittedCode = requireText(input?.code, 64)
    if (!challengeToken || !submittedCode) {
      throw new ServiceError(401, 'INVALID_MFA', genericMfaMessage)
    }

    const challenge = await this.repository.getMfaChallenge(hashToken(challengeToken))
    if (!challenge?.secretEncrypted) {
      throw new ServiceError(401, 'INVALID_MFA', genericMfaMessage)
    }

    let completed = false
    let recoveryCodes
    if (challenge.purpose === 'authentication' && normalizeRecoveryCode(submittedCode).length === 16) {
      completed = await this.repository.consumeMfaRecoveryCode({
        challengeId: challenge.id,
        userId: challenge.userId,
        codeHash: hashRecoveryCode(submittedCode),
      })
    } else {
      let secret
      try {
        secret = decryptMfaSecret(challenge.secretEncrypted, this.mfaEncryptionKey)
      } catch {
        throw new ServiceError(401, 'INVALID_MFA', genericMfaMessage)
      }
      const step = verifyTotpCode(secret, submittedCode)
      if (step !== null && (challenge.lastUsedStep === null || step > challenge.lastUsedStep)) {
        if (challenge.purpose === 'enrollment') {
          recoveryCodes = createRecoveryCodes()
          completed = await this.repository.completeMfaEnrollment({
            challengeId: challenge.id,
            userId: challenge.userId,
            secretEncrypted: challenge.secretEncrypted,
            lastUsedStep: step,
            recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
          })
        } else if (challenge.factorId) {
          completed = await this.repository.completeMfaAuthentication({
            challengeId: challenge.id,
            factorId: challenge.factorId,
            userId: challenge.userId,
            step,
          })
        }
      }
    }

    if (!completed) {
      await this.repository.recordMfaFailure(challenge.id)
      throw new ServiceError(401, 'INVALID_MFA', genericMfaMessage)
    }

    return {
      status: 'authenticated',
      ...(await this.#newSession(challenge.userId, undefined, true)),
      ...(recoveryCodes ? { recoveryCodes } : {}),
    }
  }

  async requestPasswordReset(input) {
    const email = normalizeEmail(input?.email)
    const account = validateEmail(email) ? await this.repository.findUserByEmail(email) : null

    if (account?.status === 'active') {
      const token = createOpaqueToken()
      await this.repository.createPasswordReset({
        userId: account.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + this.resetLifetimeMs),
      })
      await this.notifyPasswordReset({ email, token })
    }

    return {
      message: 'Se existir uma conta para esse e-mail, enviaremos as instruções de recuperação.',
    }
  }

  async resetPassword(input) {
    if (!requireText(input?.token, 256) || !validatePassword(input?.password)) {
      throw new ServiceError(400, 'INVALID_RESET', 'O link de recuperação é inválido ou expirou.')
    }
    const passwordHash = await hashPassword(input.password)
    const changed = await this.repository.consumePasswordReset({
      tokenHash: hashToken(input.token),
      passwordHash,
    })
    if (!changed) {
      throw new ServiceError(400, 'INVALID_RESET', 'O link de recuperação é inválido ou expirou.')
    }
    return { message: 'Senha redefinida. Entre novamente com a nova senha.' }
  }

  async logout(token) {
    if (token) await this.repository.revokeSession(hashToken(token))
  }

  async registerPushDevice(token, input) {
    const session = await this.getSession(token)
    const platform = input?.platform
    const pushToken = typeof input?.token === 'string' ? input.token.trim() : ''
    if (!pushPlatforms.has(platform) || pushToken.length < 20 || pushToken.length > 4096
      || /\s/u.test(pushToken)) {
      throw new ServiceError(400, 'INVALID_PUSH_DEVICE', 'Informe um token e uma plataforma de push válidos.')
    }
    return this.repository.registerPushDevice({
      userId: session.user.id,
      platform,
      tokenCiphertext: this.pushTokenCipher.encrypt(pushToken),
      tokenFingerprint: this.pushTokenCipher.fingerprint(pushToken),
    })
  }

  async listPushDevices(token) {
    const session = await this.getSession(token)
    return this.repository.listPushDevices({ userId: session.user.id })
  }

  async revokePushDevice(token, deviceId) {
    const session = await this.getSession(token)
    if (!requireText(deviceId, 64) || !uuidPattern.test(deviceId)) {
      throw new ServiceError(400, 'INVALID_PUSH_DEVICE', 'Dispositivo de push inválido.')
    }
    const revoked = await this.repository.revokePushDevice({ userId: session.user.id, deviceId })
    if (!revoked) throw new ServiceError(404, 'PUSH_DEVICE_NOT_FOUND', 'Dispositivo de push não encontrado.')
    return { id: deviceId, active: false }
  }

  async listNotificationPreferences(token, organizationId) {
    const session = await this.getSession(token)
    this.#requireOrganization(session, organizationId)
    const preferences = await this.repository.listNotificationPreferences({
      userId: session.user.id, organizationId, eventTypes: pushEventTypes,
    })
    if (!preferences) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    return { channel: 'push', preferences }
  }

  async updateNotificationPreference(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requireOrganization(session, organizationId)
    if (!pushEventTypes.includes(input?.eventType) || typeof input?.enabled !== 'boolean') {
      throw new ServiceError(400, 'INVALID_NOTIFICATION_PREFERENCE', 'Preferência de notificação inválida.')
    }
    const preference = await this.repository.updateNotificationPreference({
      userId: session.user.id,
      organizationId,
      eventType: input.eventType,
      enabled: input.enabled,
    })
    if (!preference) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    return { channel: 'push', ...preference }
  }

  async getSession(token) {
    if (!token) throw new ServiceError(401, 'UNAUTHENTICATED', 'Sessão necessária.')
    const session = await this.repository.getSession(hashToken(token))
    if (!session) throw new ServiceError(401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')
    return session
  }

  async selectOrganization(token, organizationId) {
    if (!token || !requireText(organizationId, 64)) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    const selected = await this.repository.selectOrganization(hashToken(token), organizationId)
    if (!selected) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    return this.getSession(token)
  }

  async createOrganization(token, input) {
    const session = await this.getSession(token)
    const name = requireText(input?.name)
    if (!name) throw new ServiceError(400, 'INVALID_ORGANIZATION', 'Informe o nome da organização.')
    await this.repository.createOrganization({ userId: session.user.id, name })
    return this.getSession(token)
  }

  async listMemberships(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'memberships.read')
    const memberships = await this.repository.listMemberships({ actorUserId: session.user.id, organizationId })
    return memberships.map((membership) => {
      const item = { ...membership }
      if (item.tokenCiphertext) {
        try {
          const rawToken = decryptMfaSecret(item.tokenCiphertext, this.mfaEncryptionKey)
          item.inviteToken = rawToken
          item.inviteUrl = `/#register?invite=${encodeURIComponent(rawToken)}`
        } catch {
          // ignore decryption error
        }
        delete item.tokenCiphertext
      }
      return item
    })
  }

  async inviteMember(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'memberships.manage')
    const roleCode = requireText(input?.roleCode, 64)
    if (!roleCode) {
      throw new ServiceError(400, 'INVALID_MEMBERSHIP', 'Informe a função do convite.')
    }
    const rawEmail = input?.email ? normalizeEmail(input.email) : null
    if (rawEmail && !validateEmail(rawEmail)) {
      throw new ServiceError(400, 'INVALID_MEMBERSHIP', 'Informe um e-mail válido.')
    }
    if (roleCode === 'owner' || roleCode === 'admin') {
      this.#requirePermission(session, organizationId, 'roles.manage_privileged')
    }

    const inviteToken = createOpaqueToken()
    const inviteTokenHash = hashToken(inviteToken)
    const inviteTokenCiphertext = encryptMfaSecret(inviteToken, this.mfaEncryptionKey)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const membership = await this.repository.inviteMember({
      actorUserId: session.user.id,
      organizationId,
      email: rawEmail,
      roleCode,
      inviteTokenHash,
      inviteTokenCiphertext,
      expiresAt,
    })

    return {
      ...membership,
      token: inviteToken,
      inviteUrl: `/#register?invite=${encodeURIComponent(inviteToken)}`,
    }
  }

  async revokeMembership(token, organizationId, membershipId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'memberships.manage')
    const revoked = await this.repository.revokeMembership({
      actorUserId: session.user.id,
      organizationId,
      membershipId,
    })
    if (!revoked) throw new ServiceError(404, 'MEMBERSHIP_NOT_FOUND', 'Vínculo não encontrado.')
  }

  async listAuditEvents(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'audit.read')

    const limit = input.limit === undefined || input.limit === '' ? 50 : Number(input.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServiceError(400, 'INVALID_AUDIT_FILTER', 'O limite deve estar entre 1 e 100.')
    }
    const action = optionalAuditName(input.action, 100)
    const targetType = optionalAuditName(input.targetType, 64)
    const targetId = input.targetId === undefined || input.targetId === '' ? null : input.targetId
    if (targetId !== null && !uuidPattern.test(targetId)) {
      throw new ServiceError(400, 'INVALID_AUDIT_FILTER', 'Filtro de auditoria inválido.')
    }

    const result = await this.repository.listAuditEvents({
      actorUserId: session.user.id,
      organizationId,
      limit,
      action,
      targetType,
      targetId,
      cursor: parseAuditCursor(input.cursor),
    })
    return { events: result.events, nextCursor: encodeAuditCursor(result.next) }
  }

  async listClients(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.read')
    const clientType = input.clientType ?? null
    if (clientType !== null && clientType !== 'fixed' && clientType !== 'rotating') {
      throw new ServiceError(400, 'INVALID_CLIENT_FILTER', 'Filtro de tipo de cliente inválido.')
    }
    const search = input.search === undefined || input.search === null
      ? ''
      : typeof input.search === 'string'
        ? input.search.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('pt-BR')
        : null
    const page = input.page === undefined || input.page === '' ? 1 : Number(input.page)
    const pageSize = input.pageSize === undefined || input.pageSize === '' ? 20 : Number(input.pageSize)
    if (search === null || search.length > 100 || !Number.isInteger(page) || page < 1 || page > 10_000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ServiceError(400, 'INVALID_CLIENT_FILTER', 'Busca ou paginação de clientes inválida.')
    }
    const result = await this.repository.listClients({
      actorUserId: session.user.id, organizationId, clientType,
      search: search || null,
      contactSearch: search ? (search.replace(/\D/gu, '') || search) : null,
      page,
      pageSize,
    })
    return {
      items: result.items,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    }
  }

  async getReportFilters(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    return this.repository.getReportFilters({ actorUserId: session.user.id, organizationId })
  }

  async listBirthdayReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input)
    const result = await this.repository.listBirthdayReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
      },
      items: result.items,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / filters.pageSize),
      },
    }
  }

  async exportBirthdayReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input, { exporting: true })
    const result = await this.repository.listBirthdayReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    if (result.total > 10_000) {
      throw new ServiceError(
        413, 'REPORT_TOO_LARGE', 'Refine os filtros antes de exportar mais de 10.000 registros.',
      )
    }
    return {
      content: birthdayReportCsv(result.items),
      filename: `aniversariantes-${filters.from}-${filters.to}.csv`,
    }
  }

  async listClientReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeClientReportFilters(input)
    const result = await this.repository.listClientReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
        clientType: filters.clientType,
      },
      items: result.items,
      totals: result.totals,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.totals.total,
        totalPages: Math.ceil(result.totals.total / filters.pageSize),
      },
    }
  }

  async exportClientReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeClientReportFilters(input, { exporting: true })
    const result = await this.repository.listClientReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    if (result.totals.total > 10_000) {
      throw new ServiceError(
        413, 'REPORT_TOO_LARGE', 'Refine os filtros antes de exportar mais de 10.000 registros.',
      )
    }
    return {
      content: clientReportCsv(result.items),
      filename: `clientes-${filters.clientType}-${filters.from}-${filters.to}.csv`,
    }
  }

  async listClientActivityReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeActivityReportFilters(input)
    const result = await this.repository.listClientActivityReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
        granularity: filters.granularity,
        bucket: filters.bucket,
      },
      items: result.items,
      details: result.details,
      pagination: filters.bucket ? {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.detailTotal,
        totalPages: Math.ceil(result.detailTotal / filters.pageSize),
      } : null,
    }
  }

  async exportClientActivityReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeActivityReportFilters(input, { exporting: true })
    const result = await this.repository.listClientActivityReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    if (filters.bucket && result.detailTotal > 10_000) {
      throw new ServiceError(
        413, 'REPORT_TOO_LARGE', 'Refine os filtros antes de exportar mais de 10.000 registros.',
      )
    }
    return {
      content: clientActivityReportCsv(result, filters.bucket),
      filename: `atividade-clientes-${filters.granularity}-${filters.bucket ?? `${filters.from}-${filters.to}`}.csv`,
    }
  }

  async getBusinessDashboardReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input)
    const result = await this.repository.getBusinessDashboardReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
      },
      ...result,
    }
  }

  async exportBusinessDashboardReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input, { exporting: true })
    const result = await this.repository.getBusinessDashboardReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      content: businessDashboardReportCsv(result),
      filename: `dashboard-negocio-${filters.from}-${filters.to}.csv`,
    }
  }

  async listEquipmentUsageReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeEquipmentUsageReportFilters(input)
    const result = await this.repository.listEquipmentUsageReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
        modalityId: filters.modalityId,
      },
      items: result.items,
      totals: result.totals,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / filters.pageSize),
      },
    }
  }

  async exportEquipmentUsageReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeEquipmentUsageReportFilters(input, { exporting: true })
    const result = await this.repository.listEquipmentUsageReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    if (result.total > 10_000) {
      throw new ServiceError(
        413, 'REPORT_TOO_LARGE', 'Refine os filtros antes de exportar mais de 10.000 registros.',
      )
    }
    return {
      content: equipmentUsageReportCsv(result.items),
      filename: `aparelhos-utilizados-${filters.from}-${filters.to}.csv`,
    }
  }

  async listProspectReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input)
    const result = await this.repository.listProspectReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    return {
      appliedFilters: {
        from: filters.from,
        to: filters.to,
        unitId: filters.unitId,
        professionalId: filters.professionalId,
        status: filters.status,
      },
      items: result.items,
      totals: result.totals,
      stages: result.stages,
      sources: result.sources,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.totals.total,
        totalPages: Math.ceil(result.totals.total / filters.pageSize),
      },
    }
  }

  async exportProspectReport(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'reports.read')
    const filters = normalizeReportFilters(input, { exporting: true })
    const result = await this.repository.listProspectReport({
      actorUserId: session.user.id,
      organizationId,
      ...filters,
    })
    if (result.totals.total > 10_000) {
      throw new ServiceError(
        413, 'REPORT_TOO_LARGE', 'Refine os filtros antes de exportar mais de 10.000 registros.',
      )
    }
    return {
      content: prospectReportCsv(result.items),
      filename: `prospeccoes-${filters.from}-${filters.to}.csv`,
    }
  }

  async listReceivables(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.read')
    const status = input.status ?? null
    if (status !== null && !receivableStatuses.has(status)) {
      throw new ServiceError(400, 'INVALID_RECEIVABLE_FILTER', 'Filtro de situação inválido.')
    }
    const search = input.search === undefined || input.search === null
      ? ''
      : typeof input.search === 'string' ? input.search.trim().replace(/\s+/gu, ' ') : null
    const page = input.page === undefined || input.page === '' ? 1 : Number(input.page)
    const pageSize = input.pageSize === undefined || input.pageSize === '' ? 20 : Number(input.pageSize)
    const dueFrom = optionalDate(input.dueFrom, 'INVALID_RECEIVABLE_FILTER', 'Período de vencimento inválido.')
    const dueTo = optionalDate(input.dueTo, 'INVALID_RECEIVABLE_FILTER', 'Período de vencimento inválido.')
    if (search === null || search.length > 100 || !Number.isInteger(page) || page < 1 || page > 10_000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || (dueFrom && dueTo && dueFrom > dueTo)) {
      throw new ServiceError(400, 'INVALID_RECEIVABLE_FILTER', 'Busca, período ou paginação inválidos.')
    }
    return this.repository.listReceivables({
      actorUserId: session.user.id, organizationId, status,
      search: search || null, dueFrom, dueTo, page, pageSize,
    })
  }

  async getReceivable(token, organizationId, receivableId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.read')
    if (!uuidPattern.test(receivableId)) {
      throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    }
    const receivable = await this.repository.getReceivable({
      actorUserId: session.user.id, organizationId, receivableId,
    })
    if (!receivable) throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    return receivable
  }

  async createReceivable(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    try {
      return await this.repository.createReceivable({
        actorUserId: session.user.id,
        organizationId,
        receivable: normalizeReceivableInput(input),
      })
    } catch (error) {
      if (error?.code === '23503') {
        throw new ServiceError(400, 'INVALID_RECEIVABLE_REFERENCE', 'Cliente ou categoria indisponível.')
      }
      throw error
    }
  }

  async generateContractReceivables(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    return this.repository.generateContractReceivables({
      actorUserId: session.user.id,
      organizationId,
      generation: normalizeContractBillingInput(input),
    })
  }

  async updateReceivable(token, organizationId, receivableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(receivableId)) {
      throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    }
    const receivable = await this.repository.updateReceivable({
      actorUserId: session.user.id, organizationId, receivableId,
      receivable: normalizeReceivableInput(input, { updating: true }),
    })
    if (!receivable) throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    return receivable
  }

  async cancelReceivable(token, organizationId, receivableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(receivableId)) {
      throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    }
    const reason = requireText(input?.reason, 200)
    if (!reason || reason.length < 3) {
      throw new ServiceError(400, 'INVALID_CANCELLATION', 'Informe o motivo do cancelamento.')
    }
    const receivable = await this.repository.cancelReceivable({
      actorUserId: session.user.id, organizationId, receivableId, reason,
    })
    if (!receivable) throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    return receivable
  }

  async createReceivablePayment(token, organizationId, receivableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(receivableId)) {
      throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    }
    if (input && Array.isArray(input.payments)) {
      if (input.payments.length === 0) {
        throw new ServiceError(400, 'INVALID_PAYMENT', 'Informe ao menos uma parte do recebimento.')
      }
      const normalizedPayments = input.payments.map((p) => normalizeFinancialPayment(p, 'recebimento'))
      const result = await this.repository.createReceivablePayments({
        actorUserId: session.user.id, organizationId, receivableId,
        payments: normalizedPayments,
      })
      if (!result) throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
      return result
    }
    const result = await this.repository.createReceivablePayment({
      actorUserId: session.user.id, organizationId, receivableId,
      payment: normalizeFinancialPayment(input, 'recebimento'),
    })
    if (!result) throw new ServiceError(404, 'RECEIVABLE_NOT_FOUND', 'Conta a receber não encontrada.')
    return result
  }

  async reverseReceivablePayment(token, organizationId, receivableId, paymentId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(receivableId) || !uuidPattern.test(paymentId)) {
      throw new ServiceError(404, 'PAYMENT_NOT_FOUND', 'Recebimento não encontrado.')
    }
    const result = await this.repository.reverseReceivablePayment({
      actorUserId: session.user.id, organizationId, receivableId, paymentId,
      reversal: normalizePaymentReversal(input),
    })
    if (!result) throw new ServiceError(404, 'PAYMENT_NOT_FOUND', 'Recebimento não encontrado.')
    return result
  }

  async createFinancialCategory(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    const name = requireText(input?.name, 120)
    const kind = input?.kind
    if (!name || name.length < 2 || !['receivable', 'payable', 'both'].includes(kind)) {
      throw new ServiceError(400, 'INVALID_FINANCIAL_CATEGORY', 'Informe nome e tipo válidos para a categoria.')
    }
    return this.repository.createFinancialCategory({
      actorUserId: session.user.id, organizationId, category: { name, kind },
    })
  }

  async listPayables(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.read')
    const status = input.status ?? null
    if (status !== null && !payableStatuses.has(status)) {
      throw new ServiceError(400, 'INVALID_PAYABLE_FILTER', 'Filtro de situação inválido.')
    }
    const search = input.search === undefined || input.search === null
      ? '' : typeof input.search === 'string' ? input.search.trim().replace(/\s+/gu, ' ') : null
    const page = input.page === undefined || input.page === '' ? 1 : Number(input.page)
    const pageSize = input.pageSize === undefined || input.pageSize === '' ? 20 : Number(input.pageSize)
    const dueFrom = optionalDate(input.dueFrom, 'INVALID_PAYABLE_FILTER', 'Período de vencimento inválido.')
    const dueTo = optionalDate(input.dueTo, 'INVALID_PAYABLE_FILTER', 'Período de vencimento inválido.')
    if (search === null || search.length > 100 || !Number.isInteger(page) || page < 1 || page > 10_000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || (dueFrom && dueTo && dueFrom > dueTo)) {
      throw new ServiceError(400, 'INVALID_PAYABLE_FILTER', 'Busca, período ou paginação inválidos.')
    }
    return this.repository.listPayables({
      actorUserId: session.user.id, organizationId, status, search: search || null,
      dueFrom, dueTo, page, pageSize,
    })
  }

  async getPayable(token, organizationId, payableId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.read')
    if (!uuidPattern.test(payableId)) {
      throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    }
    const payable = await this.repository.getPayable({
      actorUserId: session.user.id, organizationId, payableId,
    })
    if (!payable) throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    return payable
  }

  async createPayable(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    return this.repository.createPayable({
      actorUserId: session.user.id, organizationId, payable: normalizePayableInput(input),
    })
  }

  async updatePayable(token, organizationId, payableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(payableId)) {
      throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    }
    const payable = await this.repository.updatePayable({
      actorUserId: session.user.id, organizationId, payableId,
      payable: normalizePayableInput(input, { updating: true }),
    })
    if (!payable) throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    return payable
  }

  async cancelPayable(token, organizationId, payableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(payableId)) {
      throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    }
    const reason = requireText(input?.reason, 200)
    if (!reason || reason.length < 3) {
      throw new ServiceError(400, 'INVALID_CANCELLATION', 'Informe o motivo do cancelamento.')
    }
    const payable = await this.repository.cancelPayable({
      actorUserId: session.user.id, organizationId, payableId, reason,
    })
    if (!payable) throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    return payable
  }

  async createPayablePayment(token, organizationId, payableId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(payableId)) {
      throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    }
    if (input && Array.isArray(input.payments)) {
      if (input.payments.length === 0) {
        throw new ServiceError(400, 'INVALID_PAYMENT', 'Informe ao menos uma parte do pagamento.')
      }
      const normalizedPayments = input.payments.map((p) => normalizeFinancialPayment(p, 'pagamento'))
      const result = await this.repository.createPayablePayments({
        actorUserId: session.user.id, organizationId, payableId,
        payments: normalizedPayments,
      })
      if (!result) throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
      return result
    }
    const result = await this.repository.createPayablePayment({
      actorUserId: session.user.id, organizationId, payableId,
      payment: normalizeFinancialPayment(input, 'pagamento'),
    })
    if (!result) throw new ServiceError(404, 'PAYABLE_NOT_FOUND', 'Despesa não encontrada.')
    return result
  }

  async reversePayablePayment(token, organizationId, payableId, paymentId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    if (!uuidPattern.test(payableId) || !uuidPattern.test(paymentId)) {
      throw new ServiceError(404, 'PAYMENT_NOT_FOUND', 'Baixa não encontrada.')
    }
    const result = await this.repository.reversePayablePayment({
      actorUserId: session.user.id, organizationId, payableId, paymentId,
      reversal: normalizePaymentReversal(input),
    })
    if (!result) throw new ServiceError(404, 'PAYMENT_NOT_FOUND', 'Baixa não encontrada.')
    return result
  }

  async getClientProfile(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.read')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const organization = session.organizations.find(({ id }) => id === organizationId)
    const granted = new Set(organization?.permissions ?? [])
    const sections = {
      schedule: granted.has('schedule.read'),
      plan: granted.has('finance.read'),
      finance: granted.has('finance.read'),
      history: granted.has('audit.read'),
      clinical: granted.has('clinical.read'),
    }
    const profile = await this.repository.getClientProfile({
      actorUserId: session.user.id, organizationId, clientId, sections,
    })
    if (!profile) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    return profile
  }

  async listClientClinicalRecords(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clinical.read')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const result = await this.repository.listClientClinicalRecords({
      actorUserId: session.user.id, organizationId, clientId,
    })
    if (!result) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    return result
  }

  async createClientClinicalRecord(token, organizationId, clientId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clinical.write')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const recordType = typeof input?.recordType === 'string' ? input.recordType.trim() : 'evolucao'
    const content = typeof input?.content === 'string' ? input.content.trim() : ''
    if (!content) {
      throw new ServiceError(400, 'INVALID_CLINICAL_CONTENT', 'O conteúdo da evolução é obrigatório.')
    }
    const occurredAt = input?.occurredAt ? new Date(input.occurredAt).toISOString() : null
    return this.repository.createClientClinicalRecord({
      actorUserId: session.user.id,
      organizationId,
      clientId,
      recordType,
      content,
      occurredAt,
    })
  }

  async updateProfessional(token, organizationId, professionalId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'memberships.manage')
    if (!uuidPattern.test(professionalId)) {
      throw new ServiceError(404, 'PROFESSIONAL_NOT_FOUND', 'Profissional não encontrado.')
    }
    return this.repository.updateProfessional({
      actorUserId: session.user.id,
      organizationId,
      professionalId,
      registrationNumber: input?.registrationNumber,
      displayName: input?.displayName,
    })
  }

  async getClient(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.read')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const client = await this.repository.getClient({
      actorUserId: session.user.id, organizationId, clientId,
    })
    if (!client) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    return client
  }

  async getClientArea(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.own.read')
    const area = await this.repository.getClientArea({
      actorUserId: session.user.id, organizationId,
    })
    if (!area) {
      throw new ServiceError(404, 'CLIENT_LINK_NOT_FOUND', 'Seu cadastro de cliente não foi encontrado nesta clínica.')
    }
    return area
  }

  async getOwnInvoices(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.own.read')
    return this.repository.getOwnInvoices({ actorUserId: session.user.id, organizationId })
  }

  async getOwnPublishedClinicalContent(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clinical.published.read')
    return this.repository.getOwnPublishedClinicalContent({
      actorUserId: session.user.id, organizationId,
    })
  }

  async getOwnContactChannels(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.own.read')
    return this.repository.getOwnContactChannels({
      actorUserId: session.user.id, organizationId,
    })
  }

  async listReplacementCredits(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.read')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const result = await this.repository.listReplacementCredits({
      actorUserId: session.user.id, organizationId, clientId,
    })
    if (!result) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    return result
  }

  async issueReplacementCredit(token, organizationId, clientId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const sourceParticipantId = input?.sourceParticipantId
    if (typeof sourceParticipantId !== 'string' || !uuidPattern.test(sourceParticipantId)) {
      throw new ServiceError(400, 'INVALID_REPLACEMENT_SOURCE', 'Escolha uma origem válida para a reposição.')
    }
    const expiresOn = optionalDate(
      input?.expiresOn, 'INVALID_REPLACEMENT_EXPIRATION', 'Informe uma validade válida.',
    )
    try {
      return await this.repository.issueReplacementCredit({
        actorUserId: session.user.id, organizationId, clientId, sourceParticipantId, expiresOn,
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async cancelReplacementCredit(token, organizationId, clientId, creditId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(clientId) || !uuidPattern.test(creditId)) {
      throw new ServiceError(404, 'REPLACEMENT_CREDIT_NOT_FOUND', 'Reposição não encontrada.')
    }
    const credit = await this.repository.cancelReplacementCredit({
      actorUserId: session.user.id, organizationId, clientId, creditId,
    })
    if (!credit) {
      throw new ServiceError(404, 'REPLACEMENT_CREDIT_NOT_FOUND', 'Reposição não encontrada.')
    }
    return credit
  }

  async getOwnReplacementCredits(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.read')
    return this.repository.getOwnReplacementCredits({
      actorUserId: session.user.id, organizationId,
    })
  }

  async bookOwnAppointmentWithReplacement(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    try {
      return await this.repository.bookOwnAppointmentWithReplacement({
        actorUserId: session.user.id, organizationId, appointmentId,
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async getOwnAppointments(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.read')
    return this.repository.getOwnAppointments({
      actorUserId: session.user.id, organizationId,
    })
  }

  async getOwnWaitlist(token, organizationId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.read')
    return this.repository.getOwnWaitlist({
      actorUserId: session.user.id, organizationId,
    })
  }

  async joinOwnWaitlist(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    return this.repository.joinOwnWaitlist({
      actorUserId: session.user.id, organizationId, appointmentId,
    })
  }

  async leaveOwnWaitlist(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    return this.repository.leaveOwnWaitlist({
      actorUserId: session.user.id, organizationId, appointmentId,
    })
  }

  async confirmOwnWaitlistOffer(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    try {
      return await this.repository.confirmOwnWaitlistOffer({
        actorUserId: session.user.id, organizationId, appointmentId,
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async selfCheckIn(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.own.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    return this.repository.selfCheckIn({
      actorUserId: session.user.id, organizationId, appointmentId,
    })
  }

  async createClient(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.manage')
    try {
      return await this.repository.createClient({
        actorUserId: session.user.id,
        organizationId,
        client: normalizeClientInput(input),
      })
    } catch (error) {
      if (error?.code === '23505') {
        throw new ServiceError(409, 'CLIENT_DUPLICATE', 'Já existe um cliente com esse documento ou contato.')
      }
      throw error
    }
  }

  async updateClient(token, organizationId, clientId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.manage')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    try {
      const client = await this.repository.updateClient({
        actorUserId: session.user.id,
        organizationId,
        clientId,
        client: normalizeClientInput(input),
      })
      if (!client) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
      return client
    } catch (error) {
      if (error?.code === '23505') {
        throw new ServiceError(409, 'CLIENT_DUPLICATE', 'Já existe um cliente com esse documento ou contato.')
      }
      throw error
    }
  }

  async archiveClient(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'clients.manage')
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const archived = await this.repository.archiveClient({
      actorUserId: session.user.id, organizationId, clientId,
    })
    if (!archived) throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
  }

  async listPlans(token, organizationId) {
    const session = await this.getSession(token)
    this.#requireAnyPermission(session, organizationId, [
      'finance.read', 'clients.read', 'clients.manage', 'finance.manage',
    ])
    return this.repository.listPlans({ actorUserId: session.user.id, organizationId })
  }

  async createPlan(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'finance.manage')
    const plan = normalizePlanInput(input)
    return this.repository.createPlan({ actorUserId: session.user.id, organizationId, plan })
  }

  async listClientContracts(token, organizationId, clientId) {
    const session = await this.getSession(token)
    this.#requireAnyPermission(session, organizationId, [
      'finance.read', 'clients.read', 'clients.manage', 'finance.manage',
    ])
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    return this.repository.listClientContracts({ actorUserId: session.user.id, organizationId, clientId })
  }

  async createClientContract(token, organizationId, clientId, input) {
    const session = await this.getSession(token)
    this.#requireAnyPermission(session, organizationId, ['clients.manage', 'finance.manage'])
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    const contract = normalizeContractInput(input)
    return this.repository.createClientContract({
      actorUserId: session.user.id,
      organizationId,
      clientId,
      contract,
    })
  }

  async updateClientContract(token, organizationId, clientId, contractId, input) {
    const session = await this.getSession(token)
    this.#requireAnyPermission(session, organizationId, ['clients.manage', 'finance.manage'])
    if (!uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'CLIENT_NOT_FOUND', 'Cliente não encontrado.')
    }
    if (!uuidPattern.test(contractId)) {
      throw new ServiceError(404, 'CONTRACT_NOT_FOUND', 'Contrato não encontrado.')
    }
    const patch = normalizeContractPatch(input)
    return this.repository.updateClientContract({
      actorUserId: session.user.id,
      organizationId,
      clientId,
      contractId,
      patch,
    })
  }

  async listProspects(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.read')
    const stage = input.stage === undefined || input.stage === '' ? null : input.stage
    const allowedStages = new Set([...prospectStages, 'converted'])
    if (stage !== null && !allowedStages.has(stage)) {
      throw new ServiceError(400, 'INVALID_PROSPECT_FILTER', 'Filtro de etapa inválido.')
    }
    const search = input.search === undefined || input.search === null
      ? ''
      : typeof input.search === 'string'
        ? input.search.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('pt-BR')
        : null
    const page = input.page === undefined || input.page === '' ? 1 : Number(input.page)
    const pageSize = input.pageSize === undefined || input.pageSize === '' ? 50 : Number(input.pageSize)
    if (search === null || search.length > 100 || !Number.isInteger(page) || page < 1 || page > 10_000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ServiceError(400, 'INVALID_PROSPECT_FILTER', 'Busca ou paginação de prospecções inválida.')
    }
    const result = await this.repository.listProspects({
      actorUserId: session.user.id,
      organizationId,
      stage,
      search: search || null,
      contactSearch: search ? (search.replace(/\D/gu, '') || search) : null,
      page,
      pageSize,
    })
    return {
      items: result.items,
      owners: result.owners,
      stageCounts: result.stageCounts,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    }
  }

  async getProspect(token, organizationId, prospectId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.read')
    if (!uuidPattern.test(prospectId)) {
      throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    }
    const prospect = await this.repository.getProspect({
      actorUserId: session.user.id, organizationId, prospectId,
    })
    if (!prospect) throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    return prospect
  }

  async createProspect(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.manage')
    try {
      return await this.repository.createProspect({
        actorUserId: session.user.id,
        organizationId,
        prospect: normalizeProspectInput(input),
      })
    } catch (error) {
      if (error?.code === '23503') {
        throw new ServiceError(400, 'INVALID_PROSPECT_OWNER', 'O responsável não pertence a esta organização.')
      }
      throw error
    }
  }

  async updateProspect(token, organizationId, prospectId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.manage')
    if (!uuidPattern.test(prospectId)) {
      throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    }
    try {
      const prospect = await this.repository.updateProspect({
        actorUserId: session.user.id,
        organizationId,
        prospectId,
        prospect: normalizeProspectInput(input),
      })
      if (!prospect) throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
      return prospect
    } catch (error) {
      if (error?.code === '23503') {
        throw new ServiceError(400, 'INVALID_PROSPECT_OWNER', 'O responsável não pertence a esta organização.')
      }
      throw error
    }
  }

  async addProspectInteraction(token, organizationId, prospectId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.manage')
    if (!uuidPattern.test(prospectId)) {
      throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    }
    const interaction = await this.repository.addProspectInteraction({
      actorUserId: session.user.id,
      organizationId,
      prospectId,
      interaction: normalizeProspectInteraction(input),
    })
    if (!interaction) throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    return interaction
  }

  async convertProspect(token, organizationId, prospectId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'prospects.manage')
    this.#requirePermission(session, organizationId, 'clients.manage')
    if (!uuidPattern.test(prospectId)) {
      throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
    }
    try {
      const result = await this.repository.convertProspect({
        actorUserId: session.user.id,
        organizationId,
        prospectId,
        conversion: normalizeProspectConversion(input),
      })
      if (!result) throw new ServiceError(404, 'PROSPECT_NOT_FOUND', 'Prospecção não encontrada.')
      return result
    } catch (error) {
      if (error?.code === '23505') {
        throw new ServiceError(409, 'CLIENT_DUPLICATE', 'Já existe um cliente com esse documento ou contato.')
      }
      throw error
    }
  }

  async listResources(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'resources.read')
    const status = input.status ?? 'all'
    if (!['all', 'active', 'inactive'].includes(status)) {
      throw new ServiceError(400, 'INVALID_RESOURCE_FILTER', 'Filtro de recursos inválido.')
    }
    return this.repository.listResources({
      actorUserId: session.user.id,
      organizationId,
      active: status === 'all' ? null : status === 'active',
    })
  }

  async createResource(token, organizationId, kind, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'resources.manage')
    const normalizedKind = normalizeResourceKind(kind)
    try {
      return await this.repository.createResource({
        actorUserId: session.user.id,
        organizationId,
        kind: normalizedKind,
        resource: normalizeResourceInput(normalizedKind, input),
      })
    } catch (error) {
      if (error?.code === '23505') {
        throw new ServiceError(409, 'RESOURCE_DUPLICATE', 'Já existe um recurso com esse nome no mesmo contexto.')
      }
      if (error?.code === '23503') {
        throw new ServiceError(400, 'INVALID_RESOURCE_REFERENCE', 'A modalidade ou unidade informada não está disponível.')
      }
      throw error
    }
  }

  async updateResource(token, organizationId, kind, resourceId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'resources.manage')
    const normalizedKind = normalizeResourceKind(kind)
    if (!uuidPattern.test(resourceId)) {
      throw new ServiceError(404, 'RESOURCE_NOT_FOUND', 'Recurso não encontrado.')
    }
    try {
      const resource = await this.repository.updateResource({
        actorUserId: session.user.id,
        organizationId,
        kind: normalizedKind,
        resourceId,
        resource: normalizeResourceInput(normalizedKind, input),
      })
      if (!resource) throw new ServiceError(404, 'RESOURCE_NOT_FOUND', 'Recurso não encontrado.')
      return resource
    } catch (error) {
      if (error?.code === '23505') {
        throw new ServiceError(409, 'RESOURCE_DUPLICATE', 'Já existe um recurso com esse nome no mesmo contexto.')
      }
      if (error?.code === '23503') {
        throw new ServiceError(400, 'INVALID_RESOURCE_REFERENCE', 'A modalidade ou unidade informada não está disponível.')
      }
      throw error
    }
  }

  async getSchedule(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.read')
    return this.repository.getSchedule({
      actorUserId: session.user.id,
      organizationId,
      ...normalizeScheduleRange(input),
    })
  }

  async listAvailability(token, organizationId, input = {}) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.read')
    const professionalId = input.professionalId
      ? requireUuid(input.professionalId, 'INVALID_AVAILABILITY_FILTER', 'Escolha um profissional válido.')
      : null
    return this.repository.listAvailability({
      actorUserId: session.user.id, organizationId, professionalId,
    })
  }

  async createAvailability(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    try {
      return await this.repository.createAvailability({
        actorUserId: session.user.id,
        organizationId,
        availability: normalizeAvailabilityInput(input),
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async updateAvailability(token, organizationId, availabilityId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(availabilityId)) {
      throw new ServiceError(404, 'AVAILABILITY_NOT_FOUND', 'Regra de disponibilidade não encontrada.')
    }
    try {
      const availability = await this.repository.updateAvailability({
        actorUserId: session.user.id,
        organizationId,
        availabilityId,
        availability: normalizeAvailabilityInput(input),
      })
      if (!availability) {
        throw new ServiceError(404, 'AVAILABILITY_NOT_FOUND', 'Regra de disponibilidade não encontrada.')
      }
      return availability
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async createAppointment(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    try {
      return await this.repository.createAppointment({
        actorUserId: session.user.id,
        organizationId,
        appointment: normalizeAppointmentInput(input),
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async createClassAppointment(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    try {
      return await this.repository.createClassAppointment({
        actorUserId: session.user.id,
        organizationId,
        appointment: normalizeClassAppointmentInput(input),
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async addAppointmentParticipant(token, organizationId, appointmentId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    const clientId = requireUuid(
      input?.clientId, 'INVALID_APPOINTMENT_REFERENCE', 'Escolha um cliente válido.',
    )
    try {
      const appointment = await this.repository.addAppointmentParticipant({
        actorUserId: session.user.id, organizationId, appointmentId, clientId,
      })
      if (!appointment) throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      return appointment
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async cancelAppointmentParticipant(token, organizationId, appointmentId, clientId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId) || !uuidPattern.test(clientId)) {
      throw new ServiceError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado.')
    }
    const appointment = await this.repository.cancelAppointmentParticipant({
      actorUserId: session.user.id, organizationId, appointmentId, clientId,
    })
    if (!appointment) throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    return appointment
  }

  async advanceWaitlistOffer(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    return this.repository.advanceWaitlistOffer({
      actorUserId: session.user.id, organizationId, appointmentId,
    })
  }

  async updateAppointmentParticipantStatus(token, organizationId, appointmentId, participantId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId) || !uuidPattern.test(participantId)) {
      throw new ServiceError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado.')
    }
    try {
      const appointment = await this.repository.updateAppointmentParticipantStatus({
        actorUserId: session.user.id, organizationId, appointmentId, participantId,
        ...normalizeParticipantStatusInput(input),
      })
      if (!appointment) throw new ServiceError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado.')
      return appointment
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async createAppointmentSeries(token, organizationId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    try {
      return await this.repository.createAppointmentSeries({
        actorUserId: session.user.id,
        organizationId,
        series: normalizeAppointmentSeriesInput(input),
      })
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async updateAppointmentOccurrences(token, organizationId, appointmentId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    if (input?.scope !== 'single' && input?.scope !== 'future') {
      throw new ServiceError(400, 'INVALID_RECURRENCE_SCOPE', 'Escolha esta ocorrência ou esta e as futuras.')
    }
    try {
      const result = await this.repository.updateAppointmentOccurrences({
        actorUserId: session.user.id, organizationId, appointmentId,
        scope: input.scope, appointment: normalizeAppointmentInput(input),
      })
      if (!result) throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      return result
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async updateAppointment(token, organizationId, appointmentId, input) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    try {
      const appointment = await this.repository.updateAppointment({
        actorUserId: session.user.id,
        organizationId,
        appointmentId,
        appointment: normalizeAppointmentInput(input),
      })
      if (!appointment) throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
      return appointment
    } catch (error) {
      throw this.#scheduleError(error)
    }
  }

  async cancelAppointment(token, organizationId, appointmentId) {
    const session = await this.getSession(token)
    this.#requirePermission(session, organizationId, 'schedule.manage')
    if (!uuidPattern.test(appointmentId)) {
      throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    }
    const appointment = await this.repository.cancelAppointment({
      actorUserId: session.user.id, organizationId, appointmentId,
    })
    if (!appointment) throw new ServiceError(404, 'APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado.')
    return appointment
  }

  #scheduleError(error) {
    if (error instanceof ServiceError) return error
    if (error?.code === '23514' && String(error.message).includes('equipment capacity')) {
      return new ServiceError(409, 'EQUIPMENT_CONFLICT', 'A quantidade disponível do aparelho é insuficiente nesse horário.')
    }
    if (error?.code === '23514' && String(error.message).includes('equipment resource')) {
      return new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'O aparelho está inativo ou pertence a outra unidade.')
    }
    if (error?.code === '23514' && String(error.message).includes('participant status transition')) {
      return new ServiceError(409, 'INVALID_PARTICIPANT_TRANSITION', 'A mudança de presença, falta ou cancelamento não é permitida.')
    }
    if (error?.code === '23514' && String(error.message).includes('replacement credit')) {
      return new ServiceError(409, 'REPLACEMENT_CREDIT_INVALID', 'A reposição não está disponível para este agendamento.')
    }
    if (error?.code === '23514' && String(error.message).includes('attendance before')) {
      return new ServiceError(409, 'ATTENDANCE_TOO_EARLY', 'Presença ou falta só pode ser registrada após o início do atendimento.')
    }
    if (error?.code === '23514' && String(error.message).includes('capacity')) {
      return new ServiceError(409, 'CAPACITY_EXCEEDED', 'A turma atingiu a capacidade disponível.')
    }
    if (error?.code === '23514' && String(error.message).includes('fixed client')) {
      return new ServiceError(409, 'FIXED_CLIENT_REQUIRED', 'Recorrências são reservadas a clientes fixos ativos.')
    }
    if (error?.code === '23503' || error?.code === '23514') {
      return new ServiceError(400, 'INVALID_APPOINTMENT_REFERENCE', 'Um recurso do agendamento está inativo ou indisponível.')
    }
    if (error?.code === '23P01') {
      const message = String(error.message)
      const availability = message.includes('availability')
      const room = message.includes('room appointment')
      const professional = message.includes('professional appointment')
      return new ServiceError(
        409,
        availability ? 'OUTSIDE_AVAILABILITY'
          : room ? 'ROOM_CONFLICT'
            : professional ? 'PROFESSIONAL_CONFLICT' : 'SCHEDULE_CONFLICT',
        availability
          ? 'O horário está fora do expediente ou coincide com um bloqueio.'
          : room ? 'A sala já está associada a outro agendamento nesse horário.'
            : professional ? 'O profissional já possui outro agendamento nesse horário.'
              : 'O horário conflita com outro agendamento.',
      )
    }
    return error
  }

  #requireOrganization(session, organizationId) {
    if (session.organizationId !== organizationId) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    const organization = session.organizations.find(({ id }) => id === organizationId)
    if (!organization) {
      throw new ServiceError(403, 'ORGANIZATION_FORBIDDEN', 'Organização indisponível para esta conta.')
    }
    return organization
  }

  #requirePermission(session, organizationId, permissionCode) {
    const organization = this.#requireOrganization(session, organizationId)
    if (!organization.permissions?.includes(permissionCode)) {
      throw new ServiceError(403, 'PERMISSION_DENIED', 'Você não tem permissão para esta ação.')
    }
  }

  #requireAnyPermission(session, organizationId, permissionCodes) {
    const organization = this.#requireOrganization(session, organizationId)
    if (!permissionCodes.some((code) => organization.permissions?.includes(code))) {
      throw new ServiceError(403, 'PERMISSION_DENIED', 'Você não tem permissão para esta ação.')
    }
  }

  async #startMfaChallenge({ userId, email, organizationId, enrolled }) {
    const challengeToken = createOpaqueToken()
    const secret = enrolled ? null : createTotpSecret()
    await this.repository.createMfaChallenge({
      userId,
      tokenHash: hashToken(challengeToken),
      purpose: enrolled ? 'authentication' : 'enrollment',
      secretEncrypted: secret ? encryptMfaSecret(secret, this.mfaEncryptionKey) : null,
      expiresAt: new Date(Date.now() + this.mfaChallengeLifetimeMs),
    })
    return {
      status: 'mfa_required',
      organizationId,
      mfa: {
        challengeToken,
        mode: enrolled ? 'authentication' : 'enrollment',
        ...(secret ? {
          manualKey: secret,
          otpauthUri: createTotpUri({ secret, email }),
        } : {}),
      },
    }
  }

  async #newSession(userId, organizationId, mfaVerified = false) {
    const selectedOrganizationId = organizationId
      ?? (await this.repository.getPreferredOrganizationId(userId))
    const token = createOpaqueToken()
    await this.repository.createSession({
      userId,
      organizationId: selectedOrganizationId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + this.sessionLifetimeMs),
      mfaVerified,
    })
    return { token, session: await this.repository.getSession(hashToken(token)) }
  }
}
