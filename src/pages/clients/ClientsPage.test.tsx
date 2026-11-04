import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientsPage } from './ClientsPage'

const mocks = vi.hoisted(() => ({
  listClients: vi.fn(),
  getClientProfile: vi.fn(),
  createClient: vi.fn(),
  updateClient: vi.fn(),
  archiveClient: vi.fn(),
  listReplacementCredits: vi.fn(),
  issueReplacementCredit: vi.fn(),
  cancelReplacementCredit: vi.fn(),
  createClientClinicalRecord: vi.fn(),
  listPlans: vi.fn(),
  createPlan: vi.fn(),
  createClientContract: vi.fn(),
  updateClientContract: vi.fn(),
}))

vi.mock('@/features/auth', () => ({
  useAuth: () => ({
    session: {
      organizationId: 'org-test',
      organizations: [{
        id: 'org-test',
        name: 'Clínica Serena',
        permissions: ['clients.read', 'clients.manage', 'finance.read', 'finance.manage', 'clinical.read', 'clinical.write', 'schedule.manage'],
      }],
    },
  }),
  ApiError: class extends Error {},
}))

vi.mock('@/features/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/clients')>()
  return {
    ...actual,
    ...mocks,
  }
})

describe('ClientsPage - Gestão de Contratos de Clientes', () => {
  const sampleClient = {
    id: 'client-1',
    fullName: 'Ana Paula Santos',
    clientType: 'fixed' as const,
    birthDate: '1990-05-15',
    documentNumber: '12345678900',
    contacts: [{ id: 'contact-1', type: 'email' as const, value: 'ana@example.com', preferred: true }],
    operationalRules: { planMode: 'contract' as const, recurrenceMode: 'reserved' as const },
    status: 'active' as const,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  }

  const sampleProfile = {
    client: sampleClient,
    access: { schedule: true, plan: true, finance: true, history: true, clinical: true },
    schedule: [],
    plan: [{
      id: 'contract-1',
      planId: 'plan-1',
      name: 'Plano Pilates 2x/semana',
      startsOn: '2026-09-01',
      endsOn: null,
      status: 'active',
      agreedPriceCents: 26000,
      currency: 'BRL',
    }],
    finance: { openBalanceCents: 0, receivables: [] },
    history: [],
    clinicalRecords: [],
  }

  const samplePlans = [
    {
      id: 'plan-1',
      name: 'Plano Pilates 2x/semana',
      priceCents: 26000,
      currency: 'BRL',
      billingRule: { frequency: 'monthly', dueDay: 10 },
      active: true,
    },
    {
      id: 'plan-2',
      name: 'Plano Fisioterapia Duo',
      priceCents: 32000,
      currency: 'BRL',
      billingRule: { frequency: 'monthly', dueDay: 15 },
      active: true,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listClients.mockResolvedValue({
      items: [sampleClient],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    })
    mocks.getClientProfile.mockResolvedValue(sampleProfile)
    mocks.listReplacementCredits.mockResolvedValue({ balance: 0, credits: [] })
    mocks.listPlans.mockResolvedValue(samplePlans)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('exibe contrato ativo no perfil do cliente', async () => {
    render(<ClientsPage />)

    expect(await screen.findByText('Ana Paula Santos')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ver perfil' }))

    expect(await screen.findByText('Plano Pilates 2x/semana')).toBeInTheDocument()
    expect(screen.getByText('Nascimento 15/05/1990')).toBeInTheDocument()
    expect(screen.getByText('Ativo')).toBeInTheDocument()
    expect(screen.getByText(/R\$\s*260,00/)).toBeInTheDocument()
  })

  it('permite vincular um novo contrato selecionando o plano e definindo valor', async () => {
    mocks.createClientContract.mockResolvedValue({
      id: 'contract-2',
      clientId: 'client-1',
      planId: 'plan-2',
      name: 'Plano Fisioterapia Duo',
      startsOn: '2026-10-01',
      endsOn: '2027-10-01',
      agreedPriceCents: 32000,
      currency: 'BRL',
      status: 'active',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    })

    render(<ClientsPage />)

    expect(await screen.findByText('Ana Paula Santos')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver perfil' }))
    expect(await screen.findByText('Plano Pilates 2x/semana')).toBeInTheDocument()

    // Clica em "Novo contrato"
    fireEvent.click(screen.getByRole('button', { name: 'Novo contrato' }))

    expect(await screen.findByText('Novo contrato para o cliente')).toBeInTheDocument()

    // Seleciona o plano 2
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'plan-2' } })

    // Submete o formulário
    fireEvent.click(screen.getByRole('button', { name: 'Vincular contrato' }))

    await waitFor(() => {
      expect(mocks.createClientContract).toHaveBeenCalledWith(
        'org-test',
        'client-1',
        expect.objectContaining({
          planId: 'plan-2',
          agreedPriceCents: 32000,
          status: 'active',
        }),
      )
    })
  })

  it('permite cancelar um contrato ativo com confirmação', async () => {
    mocks.updateClientContract.mockResolvedValue({
      id: 'contract-1',
      status: 'cancelled',
    })

    render(<ClientsPage />)

    expect(await screen.findByText('Ana Paula Santos')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver perfil' }))
    expect(await screen.findByText('Plano Pilates 2x/semana')).toBeInTheDocument()

    // Clica em "Cancelar" no card do contrato
    const cancelButton = screen.getByRole('button', { name: 'Cancelar' })
    fireEvent.click(cancelButton)

    await waitFor(() => {
      expect(mocks.updateClientContract).toHaveBeenCalledWith(
        'org-test',
        'client-1',
        'contract-1',
        { status: 'cancelled' },
      )
    })
  })
})
