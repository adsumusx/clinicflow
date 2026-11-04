import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FinancePage } from './FinancePage'

const mocks = vi.hoisted(() => ({
  listReceivables: vi.fn(),
  listPayables: vi.fn(),
  getReceivable: vi.fn(),
  getPayable: vi.fn(),
  createReceivable: vi.fn(),
  updateReceivable: vi.fn(),
  cancelReceivable: vi.fn(),
  createReceivablePayment: vi.fn(),
  reverseReceivablePayment: vi.fn(),
  createPayable: vi.fn(),
  updatePayable: vi.fn(),
  cancelPayable: vi.fn(),
  createPayablePayment: vi.fn(),
  reversePayablePayment: vi.fn(),
  createFinancialCategory: vi.fn(),
  generateContractReceivables: vi.fn(),
}))

vi.mock('@/features/auth', () => ({
  useAuth: () => ({
    session: {
      organizationId: 'org-test',
      organizations: [{ id: 'org-test', name: 'Clínica Serena', permissions: ['finance.read', 'finance.manage'] }],
    },
  }),
}))

vi.mock('@/features/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/finance')>()
  return {
    ...actual,
    ...mocks,
  }
})

describe('FinancePage - Dividir pagamento em partes', () => {
  const sampleReceivable = {
    id: 'rec-1',
    description: 'Consulta Fisioterapia',
    clientId: 'client-1',
    clientName: 'Lucas Mendes',
    categoryId: 'cat-1',
    categoryName: 'Consultas',
    originalAmountCents: 15000,
    paidAmountCents: 0,
    balanceCents: 15000,
    dueOn: '2026-10-25',
    competenceOn: '2026-10-01',
    status: 'open' as const,
    currency: 'BRL' as const,
    contractId: null,
    recurrenceId: null,
    installmentNumber: null,
    installmentCount: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: '2026-10-23T12:00:00Z',
    updatedAt: '2026-10-23T12:00:00Z',
    payments: [],
    history: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listReceivables.mockResolvedValue({
      items: [sampleReceivable],
      options: {
        categories: [{ id: 'cat-1', name: 'Consultas' }],
        clients: [{ id: 'client-1', name: 'Lucas Mendes' }],
      },
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      summary: { count: 1, openBalanceCents: 15000, overdueBalanceCents: 0 },
    })
    mocks.getReceivable.mockResolvedValue(sampleReceivable)
    mocks.createReceivablePayment.mockResolvedValue({
      payments: [
        { id: 'pay-1', amountCents: 5000, method: 'cash', paidAt: '2026-10-23T12:00:00Z', externalReference: null, reversed: false, reversalReason: null, reversesPaymentId: null, createdAt: '2026-10-23T12:00:00Z' },
        { id: 'pay-2', amountCents: 10000, method: 'credit_card', paidAt: '2026-10-23T12:00:00Z', externalReference: null, reversed: false, reversalReason: null, reversesPaymentId: null, createdAt: '2026-10-23T12:00:00Z' },
      ],
      replayed: false,
    })
    mocks.createReceivable.mockResolvedValue({
      items: [sampleReceivable],
      replayed: false,
    })
  })

  it('permite dividir o pagamento em partes ao receber uma conta (dinheiro + cartão)', async () => {
    render(<FinancePage />)

    await waitFor(() => {
      expect(screen.getByText('Consulta Fisioterapia')).toBeInTheDocument()
    })

    const receiveButton = screen.getByRole('button', { name: 'Receber' })
    fireEvent.click(receiveButton)

    expect(screen.getByRole('heading', { level: 2, name: 'Registrar recebimento' })).toBeInTheDocument()

    const splitCheckbox = screen.getByLabelText(/Dividir pagamento em partes/i)
    expect(splitCheckbox).not.toBeChecked()

    fireEvent.click(splitCheckbox)
    expect(splitCheckbox).toBeChecked()

    expect(screen.getByText('Partes do pagamento')).toBeInTheDocument()
    expect(screen.getByLabelText(/Valor parte 1/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Valor parte 2/i)).toBeInTheDocument()

    // Ajusta os valores para 50,00 e 100,00
    const part1Input = screen.getByLabelText(/Valor parte 1/i)
    const part2Input = screen.getByLabelText(/Valor parte 2/i)

    fireEvent.change(part1Input, { target: { value: '50,00' } })
    fireEvent.change(part2Input, { target: { value: '100,00' } })

    const confirmButton = screen.getByRole('button', { name: 'Confirmar lançamento' })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(mocks.createReceivablePayment).toHaveBeenCalledWith(
        'org-test',
        'rec-1',
        expect.objectContaining({
          payments: expect.arrayContaining([
            expect.objectContaining({ amountCents: 5000, method: 'cash' }),
            expect.objectContaining({ amountCents: 10000, method: 'credit_card' }),
          ]),
        }),
      )
    })
  })

  it('permite lançar nova conta com pagamento imediato dividido em partes', async () => {
    render(<FinancePage />)

    await waitFor(() => {
      expect(screen.getByText('Consulta Fisioterapia')).toBeInTheDocument()
    })

    const newAccountButton = screen.getAllByRole('button', { name: 'Nova conta' })[0]
    fireEvent.click(newAccountButton)

    expect(screen.getByRole('heading', { level: 2, name: 'Nova conta a receber' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Cliente'), { target: { value: 'client-1' } })
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'cat-1' } })
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Aula de Pilates' } })
    fireEvent.change(screen.getByLabelText('Valor (R$)'), { target: { value: '1.500,00' } })

    const payNowCheckbox = screen.getByLabelText(/Registrar pagamento agora/i)
    fireEvent.click(payNowCheckbox)

    const splitCheckbox = screen.getByLabelText(/Dividir pagamento em partes/i)
    fireEvent.click(splitCheckbox)

    expect(screen.getByText('Partes do pagamento')).toBeInTheDocument()

    const part1Input = screen.getByLabelText(/Valor parte 1/i)
    const part2Input = screen.getByLabelText(/Valor parte 2/i)

    fireEvent.change(part1Input, { target: { value: '750,00' } })
    fireEvent.change(part2Input, { target: { value: '750,00' } })

    const saveButton = screen.getByRole('button', { name: 'Salvar conta' })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mocks.createReceivable).toHaveBeenCalledWith(
        'org-test',
        expect.objectContaining({
          amountCents: 150000,
          description: 'Aula de Pilates',
          clientId: 'client-1',
        }),
      )
      expect(mocks.createReceivablePayment).toHaveBeenCalledWith(
        'org-test',
        'rec-1',
        expect.objectContaining({
          payments: expect.arrayContaining([
            expect.objectContaining({ amountCents: 75000, method: 'cash' }),
            expect.objectContaining({ amountCents: 75000, method: 'credit_card' }),
          ]),
        }),
      )
    })
  })

  it('mantém o recebimento aberto ao adicionar outra forma de pagamento', async () => {
    render(<FinancePage />)
    await waitFor(() => expect(screen.getByText('Consulta Fisioterapia')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Receber' }))
    fireEvent.click(screen.getByLabelText(/Dividir pagamento em partes/i))
    fireEvent.click(screen.getByRole('button', { name: /Adicionar forma de pagamento/i }))
    expect(screen.getByRole('heading', { level: 2, name: 'Registrar recebimento' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Valor parte 3/i)).toHaveValue('0,00')
    expect(screen.getByRole('button', { name: /Adicionar forma de pagamento/i })).toBeInTheDocument()
  })

  it('mostra o erro no formulário quando a nova conta está incompleta', async () => {
    render(<FinancePage />)
    await waitFor(() => expect(screen.getByText('Consulta Fisioterapia')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: 'Nova conta' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Salvar conta' }))
    expect(await screen.findByText(/Preencha Cliente/i)).toBeInTheDocument()
    expect(mocks.createReceivable).not.toHaveBeenCalled()
  })
})
