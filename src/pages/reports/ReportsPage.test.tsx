import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from './ReportsPage'

const mocks = vi.hoisted(() => ({
  downloadBirthdayReport: vi.fn(),
  downloadBusinessDashboardReport: vi.fn(),
  downloadClientActivityReport: vi.fn(),
  downloadClientReport: vi.fn(),
  downloadEquipmentUsageReport: vi.fn(),
  downloadProspectReport: vi.fn(),
  getBusinessDashboardReport: vi.fn(),
  getReportFilters: vi.fn(),
  listBirthdayReport: vi.fn(),
  listClientActivityReport: vi.fn(),
  listClientReport: vi.fn(),
  listEquipmentUsageReport: vi.fn(),
  listProspectReport: vi.fn(),
}))

vi.mock('@/features/auth', () => ({
  useAuth: () => ({
    session: {
      organizationId: 'org-a',
      organizations: [{ id: 'org-a', permissions: ['reports.read'] }],
    },
  }),
}))

vi.mock('@/features/reports', () => mocks)

describe('ReportsPage', () => {
  beforeEach(() => {
    mocks.getReportFilters.mockReset().mockResolvedValue({
      units: [{ id: 'unit-a', name: 'Centro' }],
      professionals: [{ id: 'professional-a', displayName: 'Carla' }],
      modalities: [{ id: 'modality-a', name: 'Pilates' }],
      statuses: [{ value: 'active', label: 'Ativo' }],
    })
    mocks.listBirthdayReport.mockReset().mockResolvedValue({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30' },
      items: [{
        clientId: 'client-a', fullName: 'Ana Silva', birthDate: '1990-09-03',
        occursOn: '2026-09-03', status: 'active', contactAllowed: false,
        preferredContact: null,
      }],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    })
    mocks.listClientReport.mockReset().mockResolvedValue({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30', clientType: 'all' },
      items: [{
        clientId: 'client-a', fullName: 'Ana Silva', clientType: 'fixed', status: 'active',
        registeredOn: '2026-09-03',
        plan: { contractId: 'contract-a', name: 'Pilates 2x', startsOn: '2026-09-01', endsOn: null },
      }],
      totals: { total: 1, fixed: 1, rotating: 0, active: 1, inactive: 0 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    })
    mocks.listClientActivityReport.mockReset().mockImplementation(async (_organizationId, _filters, _granularity, bucket) => ({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30', granularity: 'month', bucket: bucket ?? null },
      items: [{ period: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', activeClients: 1, attendances: 3 }],
      details: bucket ? [{ clientId: 'client-a', fullName: 'Ana Silva', clientType: 'fixed', status: 'active', attendances: 3, lastAttendanceOn: '2026-09-20' }] : [],
      pagination: bucket ? { page: 1, pageSize: 25, total: 1, totalPages: 1 } : null,
    }))
    mocks.getBusinessDashboardReport.mockReset().mockResolvedValue({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30' },
      financial: { billedCents: 25000, receivedCents: 20000, outstandingCents: 5000 },
      operational: { appointments: 4, completedAppointments: 3, attendances: 3, absences: 1, attendanceRate: 75 },
    })
    mocks.listEquipmentUsageReport.mockReset().mockResolvedValue({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30', modalityId: null },
      items: [{
        equipmentId: 'equipment-a', equipmentName: 'Reformer', availableQuantity: 4,
        unitId: 'unit-a', unitName: 'Centro', modalityId: 'modality-a', modalityName: 'Pilates',
        appointments: 3, allocatedQuantity: 6, attendances: 8, lastUsedOn: '2026-09-20',
      }],
      totals: { equipmentTypes: 1, appointments: 3, allocatedQuantity: 6 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    })
    mocks.listProspectReport.mockReset().mockResolvedValue({
      appliedFilters: { from: '2026-09-01', to: '2026-09-30' },
      items: [{
        prospectId: 'prospect-a', fullName: 'Marina Lima', source: 'Indicação',
        stage: 'converted', ownerProfessionalId: 'professional-a', ownerDisplayName: 'Carla',
        createdOn: '2026-09-01', closedOn: '2026-09-05', cycleDays: 4,
      }],
      totals: {
        total: 3, converted: 1, lost: 1, open: 1,
        conversionRate: 33.3, lossRate: 33.3, averageCycleDays: 4.5,
      },
      stages: { new: 0, contacted: 0, qualified: 0, proposal: 1, lost: 1, converted: 1 },
      sources: [{ source: 'Indicação', total: 3, converted: 1, lost: 1, conversionRate: 33.3 }],
      pagination: { page: 1, pageSize: 25, total: 3, totalPages: 1 },
    })
  })

  it('mostra aniversariantes e não revela contato sem autorização', async () => {
    render(<ReportsPage />)

    expect(await screen.findByText('Ana Silva')).toBeInTheDocument()
    expect(screen.getByText('Contato não autorizado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled()
  })

  it('reaplica período, unidade, profissional e situação em conjunto', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'unit-a' } })
    fireEvent.change(screen.getByLabelText('Profissional'), { target: { value: 'professional-a' } })
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'active' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }))

    await waitFor(() => expect(mocks.listBirthdayReport).toHaveBeenLastCalledWith(
      'org-a',
      expect.objectContaining({
        unitId: 'unit-a', professionalId: 'professional-a', status: 'active',
      }),
      1,
    ))
  })

  it('alterna entre a base geral e os planos fixos mantendo totais conciliados', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.click(screen.getByRole('button', { name: 'Clientes e planos' }))
    expect(await screen.findByText('Pilates 2x')).toBeInTheDocument()
    expect(screen.getByLabelText('Totais da base filtrada')).toHaveTextContent('Total1')
    fireEvent.change(screen.getByLabelText('Visão de clientes'), { target: { value: 'fixed' } })

    await waitFor(() => expect(mocks.listClientReport).toHaveBeenLastCalledWith(
      'org-a', expect.any(Object), 'fixed', 1,
    ))
  })

  it('abre o drill-down mensal usando o mesmo bucket do resumo', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.click(screen.getByRole('button', { name: 'Atividade mês/ano' }))
    expect(await screen.findByText(/setembro de 2026/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver clientes' }))

    await waitFor(() => expect(mocks.listClientActivityReport).toHaveBeenLastCalledWith(
      'org-a', expect.any(Object), 'month', '2026-09', 1,
    ))
    expect(await screen.findByText('Clientes ativos em setembro de 2026')).toBeInTheDocument()
  })

  it('mostra indicadores financeiros e operacionais conciliados', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard de negócio' }))

    expect(await screen.findByLabelText('Indicadores financeiros conciliados')).toHaveTextContent('R$ 250,00')
    expect(screen.getByLabelText('Indicadores financeiros conciliados')).toHaveTextContent('R$ 200,00')
    expect(screen.getByLabelText('Indicadores operacionais conciliados')).toHaveTextContent('75%')
  })

  it('filtra aparelhos por modalidade e exibe somente uso realizado', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.click(screen.getByRole('button', { name: 'Aparelhos utilizados' }))
    expect(await screen.findByText('Reformer')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Modalidade'), { target: { value: 'modality-a' } })

    await waitFor(() => expect(mocks.listEquipmentUsageReport).toHaveBeenLastCalledWith(
      'org-a', expect.any(Object), 'modality-a', 1,
    ))
    expect(screen.getByText(/somente agendamentos concluídos/i)).toBeInTheDocument()
  })

  it('apresenta conversão, perdas, origens, etapas e tempo de ciclo das prospecções', async () => {
    render(<ReportsPage />)
    await screen.findByText('Ana Silva')

    fireEvent.click(screen.getByRole('button', { name: 'Prospecções' }))

    expect(await screen.findByText('Marina Lima')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '3 prospecções' })).toBeInTheDocument()
    expect(screen.getByLabelText('Indicadores do funil de prospecções')).toHaveTextContent('33,3% da base')
    expect(screen.getByLabelText('Indicadores do funil de prospecções')).toHaveTextContent('4,5 dias')
    expect(screen.getByText('Desempenho por origem')).toBeInTheDocument()
    expect(screen.getAllByText('Convertida').length).toBeGreaterThan(0)
  })
})
