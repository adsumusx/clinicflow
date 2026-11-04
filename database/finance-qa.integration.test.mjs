// @vitest-environment node

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService } from '../server/auth-service.mjs'
import { PostgresAuthRepository } from '../server/postgres-auth-repository.mjs'
import { readDevelopmentSeed, readMigrations } from '../scripts/db/files.mjs'

const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001'
const ownerUserId = '00000000-0000-4000-8000-000000000001'
const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
const contractId = 'aaaaaaaa-7200-4000-8000-000000000001'
const receivableCategoryId = 'aaaaaaaa-7100-4000-8000-000000000001'
const payableCategoryId = 'aaaaaaaa-7100-4000-8000-000000000002'
const financeQaRequested = process.env.npm_lifecycle_event === 'test:qa:finance'
  || process.argv.some((argument) => argument.includes('finance-qa.integration.test.mjs'))

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
}

describe.skipIf(!financeQaRequested)(
  'QA-003 — reconciliação financeira', () => {
  let db
  let pool
  let service

  async function expectReceivablesReconciled() {
    const ledger = await pool.query(
      `SELECT receivable.id, receivable.original_amount_cents,
              COALESCE(sum(payment.amount_cents), 0)::bigint AS ledger_total_cents,
              balance.paid_amount_cents, balance.balance_cents
       FROM receivables receivable
       LEFT JOIN payments payment
         ON payment.organization_id = receivable.organization_id
        AND payment.receivable_id = receivable.id
       JOIN receivable_balances balance
         ON balance.organization_id = receivable.organization_id
        AND balance.receivable_id = receivable.id
       WHERE receivable.organization_id = $1
       GROUP BY receivable.id, receivable.original_amount_cents,
                balance.paid_amount_cents, balance.balance_cents
       ORDER BY receivable.id`,
      [organizationId],
    )
    for (const row of ledger.rows) {
      const values = numericRow({
        original: row.original_amount_cents,
        ledger: row.ledger_total_cents,
        paid: row.paid_amount_cents,
        balance: row.balance_cents,
      })
      expect(values.paid).toBe(values.ledger)
      expect(values.balance).toBe(values.original - values.ledger)
      expect(values.balance).toBeGreaterThanOrEqual(0)
    }

    const independent = await pool.query(
      `WITH reconciled AS (
         SELECT receivable.status, receivable.due_on, receivable.original_amount_cents,
                COALESCE(sum(payment.amount_cents), 0)::bigint AS paid_amount_cents
         FROM receivables receivable
         LEFT JOIN payments payment
           ON payment.organization_id = receivable.organization_id
          AND payment.receivable_id = receivable.id
         WHERE receivable.organization_id = $1
         GROUP BY receivable.id
       ), effective AS (
         SELECT original_amount_cents - paid_amount_cents AS balance_cents,
                CASE
                  WHEN status = 'cancelled' THEN 'cancelled'
                  WHEN original_amount_cents - paid_amount_cents <= 0 THEN 'paid'
                  WHEN paid_amount_cents > 0 THEN 'partially_paid'
                  WHEN due_on < CURRENT_DATE THEN 'overdue'
                  ELSE 'open'
                END AS effective_status
         FROM reconciled
       )
       SELECT count(*) FILTER (
                WHERE effective_status IN ('open', 'partially_paid', 'overdue')
              )::int AS count,
              COALESCE(sum(balance_cents) FILTER (
                WHERE effective_status IN ('open', 'partially_paid', 'overdue')
              ), 0)::bigint AS open_balance_cents,
              COALESCE(sum(balance_cents) FILTER (
                WHERE effective_status = 'overdue'
              ), 0)::bigint AS overdue_balance_cents
       FROM effective`,
      [organizationId],
    )
    const listing = await service.listReceivables('qa-session', organizationId, { pageSize: 100 })
    expect(listing.summary).toEqual({
      count: independent.rows[0].count,
      openBalanceCents: Number(independent.rows[0].open_balance_cents),
      overdueBalanceCents: Number(independent.rows[0].overdue_balance_cents),
    })
  }

  async function expectPayablesReconciled() {
    const ledger = await pool.query(
      `SELECT payable.id, payable.amount_cents AS original_amount_cents,
              COALESCE(sum(payment.amount_cents), 0)::bigint AS ledger_total_cents,
              balance.paid_amount_cents, balance.balance_cents
       FROM payables payable
       LEFT JOIN payable_payments payment
         ON payment.organization_id = payable.organization_id
        AND payment.payable_id = payable.id
       JOIN payable_balances balance
         ON balance.organization_id = payable.organization_id
        AND balance.payable_id = payable.id
       WHERE payable.organization_id = $1
       GROUP BY payable.id, payable.amount_cents,
                balance.paid_amount_cents, balance.balance_cents
       ORDER BY payable.id`,
      [organizationId],
    )
    for (const row of ledger.rows) {
      const values = numericRow({
        original: row.original_amount_cents,
        ledger: row.ledger_total_cents,
        paid: row.paid_amount_cents,
        balance: row.balance_cents,
      })
      expect(values.paid).toBe(values.ledger)
      expect(values.balance).toBe(values.original - values.ledger)
      expect(values.balance).toBeGreaterThanOrEqual(0)
    }

    const independent = await pool.query(
      `WITH reconciled AS (
         SELECT payable.status, payable.due_on, payable.amount_cents,
                COALESCE(sum(payment.amount_cents), 0)::bigint AS paid_amount_cents
         FROM payables payable
         LEFT JOIN payable_payments payment
           ON payment.organization_id = payable.organization_id
          AND payment.payable_id = payable.id
         WHERE payable.organization_id = $1
         GROUP BY payable.id
       ), effective AS (
         SELECT amount_cents - paid_amount_cents AS balance_cents,
                CASE
                  WHEN status = 'cancelled' THEN 'cancelled'
                  WHEN amount_cents - paid_amount_cents <= 0 THEN 'paid'
                  WHEN paid_amount_cents > 0 THEN 'partially_paid'
                  WHEN due_on < CURRENT_DATE THEN 'overdue'
                  ELSE 'open'
                END AS effective_status
         FROM reconciled
       )
       SELECT count(*) FILTER (
                WHERE effective_status IN ('open', 'partially_paid', 'overdue')
              )::int AS count,
              COALESCE(sum(balance_cents) FILTER (
                WHERE effective_status IN ('open', 'partially_paid', 'overdue')
              ), 0)::bigint AS open_balance_cents,
              COALESCE(sum(balance_cents) FILTER (
                WHERE effective_status = 'overdue'
              ), 0)::bigint AS overdue_balance_cents
       FROM effective`,
      [organizationId],
    )
    const listing = await service.listPayables('qa-session', organizationId, { pageSize: 100 })
    expect(listing.summary).toEqual({
      count: independent.rows[0].count,
      openBalanceCents: Number(independent.rows[0].open_balance_cents),
      overdueBalanceCents: Number(independent.rows[0].overdue_balance_cents),
    })
  }

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE ROLE clinicflow_app
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    `)
    for (const migration of await readMigrations()) await db.exec(migration.up)
    await db.exec(`BEGIN; ${await readDevelopmentSeed()} COMMIT;`)
    pool = {
      query: (...args) => db.query(...args),
      connect: async () => ({ query: (...args) => db.query(...args), release: () => {} }),
    }
    const repository = new PostgresAuthRepository('postgresql://unused', { pool })
    const session = {
      user: { id: ownerUserId, email: 'proprietario.a@example.invalid' },
      organizationId,
      organizations: [{ id: organizationId, permissions: ['finance.read', 'finance.manage'] }],
    }
    service = new AuthService({
      getSession: async () => session,
      listReceivables: (input) => repository.listReceivables(input),
      getReceivable: (input) => repository.getReceivable(input),
      createReceivable: (input) => repository.createReceivable(input),
      generateContractReceivables: (input) => repository.generateContractReceivables(input),
      createReceivablePayment: (input) => repository.createReceivablePayment(input),
      reverseReceivablePayment: (input) => repository.reverseReceivablePayment(input),
      listPayables: (input) => repository.listPayables(input),
      getPayable: (input) => repository.getPayable(input),
      createPayable: (input) => repository.createPayable(input),
      createPayablePayment: (input) => repository.createPayablePayment(input),
      reversePayablePayment: (input) => repository.reversePayablePayment(input),
    }, { mfaEncryptionKey: Buffer.alloc(32) })
  }, 60_000)

  afterAll(async () => {
    await db?.close()
  }, 30_000)

  it('concilia recebimentos parciais, quitação e estorno com o resumo de contas a receber', async () => {
    const created = await service.createReceivable('qa-session', organizationId, {
      clientId,
      categoryId: receivableCategoryId,
      description: 'Recebível de reconciliação QA-003',
      amountCents: 40_000,
      competenceOn: '2099-01-01',
      dueOn: '2099-01-10',
      idempotencyKey: 'qa-003:receivable:partial-reversal',
    })
    const receivableId = created.items[0].id
    const first = await service.createReceivablePayment('qa-session', organizationId, receivableId, {
      amountCents: 15_000,
      method: 'pix',
      paidAt: '2099-01-02T12:00:00.000Z',
      idempotencyKey: 'qa-003:receivable:payment:1',
    })
    const secondInput = {
      amountCents: 25_000,
      method: 'transfer',
      paidAt: '2099-01-03T12:00:00.000Z',
      idempotencyKey: 'qa-003:receivable:payment:2',
    }
    const second = await service.createReceivablePayment(
      'qa-session', organizationId, receivableId, secondInput,
    )
    expect(await service.createReceivablePayment(
      'qa-session', organizationId, receivableId, secondInput,
    )).toMatchObject({ replayed: true, payment: { id: second.payment.id } })
    expect(await service.getReceivable('qa-session', organizationId, receivableId))
      .toMatchObject({ status: 'paid', paidAmountCents: 40_000, balanceCents: 0 })

    const reversalInput = {
      reason: 'Primeira parcela lançada na conta errada',
      reversedAt: '2099-01-04T12:00:00.000Z',
      idempotencyKey: 'qa-003:receivable:reversal:1',
    }
    const reversal = await service.reverseReceivablePayment(
      'qa-session', organizationId, receivableId, first.payment.id, reversalInput,
    )
    expect(await service.reverseReceivablePayment(
      'qa-session', organizationId, receivableId, first.payment.id, reversalInput,
    )).toMatchObject({ replayed: true, payment: { id: reversal.payment.id } })

    const detail = await service.getReceivable('qa-session', organizationId, receivableId)
    expect(detail).toMatchObject({ status: 'partially_paid', paidAmountCents: 25_000, balanceCents: 15_000 })
    expect(detail.payments.map(({ amountCents }) => amountCents).sort((a, b) => a - b))
      .toEqual([-15_000, 15_000, 25_000])
    expect(detail.payments.reduce((total, payment) => total + payment.amountCents, 0))
      .toBe(detail.paidAmountCents)
    await expectReceivablesReconciled()
  })

  it('concilia baixas parciais, quitação e estorno com o resumo de contas a pagar', async () => {
    const created = await service.createPayable('qa-session', organizationId, {
      categoryId: payableCategoryId,
      counterparty: 'Fornecedor sintético QA-003',
      description: 'Despesa de reconciliação QA-003',
      amountCents: 60_000,
      competenceOn: '2099-02-01',
      dueOn: '2099-02-10',
      idempotencyKey: 'qa-003:payable:partial-reversal',
    })
    const payableId = created.items[0].id
    const first = await service.createPayablePayment('qa-session', organizationId, payableId, {
      amountCents: 20_000,
      method: 'pix',
      paidAt: '2099-02-02T12:00:00.000Z',
      idempotencyKey: 'qa-003:payable:payment:1',
    })
    const second = await service.createPayablePayment('qa-session', organizationId, payableId, {
      amountCents: 40_000,
      method: 'transfer',
      paidAt: '2099-02-03T12:00:00.000Z',
      idempotencyKey: 'qa-003:payable:payment:2',
    })
    expect(await service.getPayable('qa-session', organizationId, payableId))
      .toMatchObject({ status: 'paid', paidAmountCents: 60_000, balanceCents: 0 })

    const reversalInput = {
      reason: 'Baixa vinculada ao fornecedor incorreto',
      reversedAt: '2099-02-04T12:00:00.000Z',
      idempotencyKey: 'qa-003:payable:reversal:1',
    }
    const reversal = await service.reversePayablePayment(
      'qa-session', organizationId, payableId, second.payment.id, reversalInput,
    )
    expect(await service.reversePayablePayment(
      'qa-session', organizationId, payableId, second.payment.id, reversalInput,
    )).toMatchObject({ replayed: true, payment: { id: reversal.payment.id } })

    const detail = await service.getPayable('qa-session', organizationId, payableId)
    expect(detail).toMatchObject({ status: 'partially_paid', paidAmountCents: 20_000, balanceCents: 40_000 })
    expect(detail.payments.map(({ amountCents }) => amountCents).sort((a, b) => a - b))
      .toEqual([-40_000, 20_000, 40_000])
    expect(detail.payments.reduce((total, payment) => total + payment.amountCents, 0))
      .toBe(detail.paidAmountCents)
    expect(first.payment.id).toBeTruthy()
    await expectPayablesReconciled()
  })

  it('gera um único recebível contratual por competência e o mantém conciliado', async () => {
    const generation = {
      contractId,
      categoryId: receivableCategoryId,
      competenceOn: '2099-03-01',
      idempotencyKey: 'qa-003:contract:2099-03',
    }
    const created = await service.generateContractReceivables(
      'qa-session', organizationId, generation,
    )
    expect(created).toMatchObject({ replayed: false, generatedCount: 1 })
    expect(created.items).toEqual([
      expect.objectContaining({
        contractId,
        originalAmountCents: 25_000,
        paidAmountCents: 0,
        balanceCents: 25_000,
        competenceOn: '2099-03-01',
        dueOn: '2099-03-10',
        status: 'open',
      }),
    ])

    const replay = await service.generateContractReceivables(
      'qa-session', organizationId, generation,
    )
    expect(replay).toMatchObject({ replayed: true, generatedCount: 0 })
    expect(replay.items.map(({ id }) => id)).toEqual(created.items.map(({ id }) => id))

    const duplicateCompetence = await service.generateContractReceivables(
      'qa-session', organizationId,
      { ...generation, idempotencyKey: 'qa-003:contract:2099-03:retry-with-new-key' },
    )
    expect(duplicateCompetence).toMatchObject({ replayed: false, generatedCount: 0 })
    expect(duplicateCompetence.items.map(({ id }) => id)).toEqual(created.items.map(({ id }) => id))

    const stored = await pool.query(
      `SELECT count(*)::int AS count, sum(original_amount_cents)::bigint AS original_total_cents
       FROM receivables
       WHERE organization_id = $1 AND contract_id = $2 AND competence_on = $3`,
      [organizationId, contractId, generation.competenceOn],
    )
    expect(numericRow(stored.rows[0])).toEqual({ count: 1, original_total_cents: 25_000 })
    await expectReceivablesReconciled()
    await expectPayablesReconciled()
  })
  },
)
