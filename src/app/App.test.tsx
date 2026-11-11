import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const authenticatedSession = {
  user: { id: 'user-a', email: 'ana@example.com' },
  organizationId: 'org-a',
  organizations: [{
    id: 'org-a',
    name: 'Clínica Serena',
    roleCode: 'owner',
    roleName: 'Proprietário',
    permissions: [
      'memberships.read', 'memberships.manage', 'roles.manage_privileged',
      'clients.read', 'clients.manage', 'schedule.read', 'finance.read', 'finance.manage', 'audit.read',
      'prospects.read', 'prospects.manage',
      'resources.read', 'resources.manage',
    ],
  }],
  expiresAt: '2026-09-02T00:00:00.000Z',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/receivables')
      ? {
          items: [], options: { clients: [], categories: [] },
          pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
          summary: { count: 0, openBalanceCents: 0, overdueBalanceCents: 0 },
        }
      : url.includes('/memberships')
      ? []
      : url.includes('/clients')
        ? { items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }
        : authenticatedSession
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
})

describe('App', () => {
  it('apresenta o Dashboard demonstrativo no shell profissional', async () => {
    window.location.hash = ''
    render(<App />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Clínica Serena',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Agenda do dia')).toBeInTheDocument()
    expect(screen.getByText('Receita da semana')).toBeInTheDocument()
    expect(await screen.findByText('Nenhum atendimento hoje')).toBeInTheDocument()
    expect(screen.getByText('Nenhum aniversariante hoje')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Navegação principal' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByRole('link', { name: 'Pular para o conteúdo' }),
    ).toHaveAttribute('href', '#main-content')
  })

  it('abre a Agenda sem horários inventados', async () => {
    window.location.hash = '#agenda'
    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Agenda' })).toBeInTheDocument()
    expect(document.querySelector('.page-heading__eyebrow')).toHaveTextContent('Clínica Serena')
    expect(screen.getByText('Nenhum atendimento neste dia')).toBeInTheDocument()
    expect(screen.getByText(/0 atendimentos/)).toBeInTheDocument()
    expect(screen.queryByText('Carlos Eduardo')).not.toBeInTheDocument()
    expect(screen.queryByText('Pilates em Grupo')).not.toBeInTheDocument()
    expect(screen.queryByText('Lotado (4/4)')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agenda' })).toHaveAttribute('aria-current', 'page')
  })

  it('mantém a Agenda vazia ao trocar o dia e a semana', async () => {
    window.location.hash = '#agenda'
    render(<App />)

    const nextWeek = await screen.findByRole('button', { name: 'Próxima semana' })
    fireEvent.click(nextWeek)

    expect(screen.getByText(/0 atendimentos/)).toBeInTheDocument()
    expect(screen.getByText('Nenhum atendimento neste dia')).toBeInTheDocument()
    expect(screen.queryByText('Carlos Eduardo')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }))
    expect(screen.getByText(/0 atendimentos/)).toBeInTheDocument()
  })

  it('ativa o botão escolhido e envia a disponibilidade preenchida', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const rule = {
      id: 'rule-1', active: true, endsAt: null, kind: 'working_hours', label: 'Manhã',
      localEndTime: '12:00:00', localStartTime: '08:00:00', professionalId: 'pro-1',
      professionalName: 'Carla', startsAt: null, timezone: 'America/Sao_Paulo',
      unitId: 'unit-1', unitName: 'Centro', weekday: 2,
    }
    const schedule = {
      appointments: [],
      clients: [],
      equipment: [],
      professionals: [{ id: 'pro-1', displayName: 'Carla' }],
      rooms: [],
      services: [],
      units: [{ id: 'unit-1', name: 'Centro' }],
    }
    const availability = {
      rules: [rule],
      clients: [],
      equipment: [],
      professionals: schedule.professionals,
      rooms: [],
      services: [],
      units: schedule.units,
    }
    const managerSession = {
      ...authenticatedSession,
      organizations: [{
        ...authenticatedSession.organizations[0],
        permissions: [...authenticatedSession.organizations[0].permissions, 'schedule.manage'],
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      let body: unknown = managerSession
      let status = 200
      if (url.includes('/appointments')) body = schedule
      if (url.includes('/availability-rules') && method === 'GET') body = availability
      if (url.includes('/availability-rules') && method === 'POST') {
        body = { ...rule, id: 'rule-2' }
        status = 201
      }
      if (url.includes('/availability-rules/rule-1') && method === 'PUT') {
        body = { ...rule, ...JSON.parse(String(init?.body)) }
      }
      return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#agenda'
    render(<App />)

    const individual = await screen.findByRole('button', { name: 'Novo individual' })
    const classButton = screen.getByRole('button', { name: 'Nova turma' })
    const availabilityButton = screen.getByRole('button', { name: 'Disponibilidade' })
    expect(individual).toHaveAttribute('aria-pressed', 'false')
    expect(classButton).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(classButton)
    expect(classButton).toHaveAttribute('aria-pressed', 'true')
    expect(individual).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('heading', { name: 'Nova turma' })).toBeInTheDocument()

    fireEvent.click(availabilityButton)
    expect(availabilityButton).toHaveAttribute('aria-pressed', 'true')
    expect(classButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('heading', { name: 'Nova turma' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Profissional'), { target: { value: 'pro-1' } })
    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'unit-1' } })
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Início'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar disponibilidade' }))

    await waitFor(() => expect(screen.getByText('Disponibilidade cadastrada com sucesso.')).toBeInTheDocument())
    const createRequest = requests.find(({ url, method }) => url.includes('/availability-rules') && method === 'POST')
    expect(JSON.parse(createRequest?.body ?? '{}')).toEqual({
      active: true, kind: 'working_hours', label: null, professionalId: 'pro-1', unitId: 'unit-1',
      timezone: 'America/Sao_Paulo', weekday: 3, localStartTime: '09:30', localEndTime: '12:00',
      startsAt: null, endsAt: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Inativar' }))
    await waitFor(() => expect(screen.getByText('Regra inativada com sucesso.')).toBeInTheDocument())
    const updateRequest = requests.find(({ url, method }) => url.includes('/availability-rules/rule-1') && method === 'PUT')
    expect(JSON.parse(updateRequest?.body ?? '{}')).toMatchObject({
      active: false, localStartTime: '08:00', localEndTime: '12:00', weekday: 2,
    })
  })

  it('abre o cadastro operacional de clientes', async () => {
    window.location.hash = '#dashboard'
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: 'Clientes' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Clientes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Novo cliente' })).toBeInTheDocument()
    expect(screen.getByText('Nenhum cliente cadastrado')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clientes' })).toHaveAttribute('aria-current', 'page')
  })

  it('cadastra um cliente pela interface e envia somente os campos permitidos', async () => {
    const requests: Array<{ method: string; body?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, body: typeof init?.body === 'string' ? init.body : undefined })
      let body: unknown = authenticatedSession
      if (url.includes('/clients') && method === 'GET') {
        body = { items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }
      }
      if (url.includes('/clients') && method === 'POST') {
        body = { id: 'client-a', fullName: 'Ana Silva', contacts: [] }
      }
      return new Response(JSON.stringify(body), {
        status: method === 'POST' ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#clients'
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Novo cliente' }))
    fireEvent.change(await screen.findByLabelText('Nome completo'), { target: { value: 'Ana Silva' } })
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@example.com' } })
    fireEvent.click(screen.getByLabelText(/Fixo/))
    fireEvent.click(screen.getAllByRole('button', { name: 'Cadastrar cliente' })[0])

    expect(await screen.findByText('Cliente cadastrado com sucesso.')).toBeInTheDocument()
    const createRequest = requests.find(({ method }) => method === 'POST')
    expect(JSON.parse(createRequest?.body ?? '{}')).toEqual({
      fullName: 'Ana Silva', clientType: 'fixed', birthDate: null, documentNumber: null,
      contacts: [{ type: 'email', value: 'ana@example.com', preferred: true }],
    })
  })

  it('filtra clientes por tipo e explica a política operacional', async () => {
    const requestedUrls: string[] = []
    const clients = [
      {
        id: 'fixed-a', fullName: 'Cliente Fixo', clientType: 'fixed', contacts: [],
        birthDate: null, documentNumber: null, status: 'active',
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
        operationalRules: { planMode: 'contract', recurrenceMode: 'reserved' },
      },
      {
        id: 'rotating-a', fullName: 'Cliente Rotativo', clientType: 'rotating', contacts: [],
        birthDate: null, documentNumber: null, status: 'active',
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
        operationalRules: { planMode: 'credits_or_single_booking', recurrenceMode: 'availability_only' },
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requestedUrls.push(url)
      const items = url.includes('type=fixed') ? clients.filter(({ clientType }) => clientType === 'fixed') : clients
      const body = url.includes('/clients')
        ? { items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 } }
        : authenticatedSession
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#clients'
    render(<App />)

    expect(await screen.findByText('Cliente Fixo')).toBeInTheDocument()
    expect(screen.getByText('Cliente Rotativo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fixos' }))

    await waitFor(() => expect(screen.queryByText('Cliente Rotativo')).not.toBeInTheDocument())
    expect(requestedUrls.some((url) => url.includes('/clients?type=fixed') && url.includes('page=1'))).toBe(true)
    expect(screen.getByText('Plano ou contrato com reserva recorrente.')).toBeInTheDocument()
  })

  it('busca, pagina e abre o perfil integrado do cliente', async () => {
    const requestedUrls: string[] = []
    const client = {
      id: 'aaaaaaaa-5000-4000-8000-000000000001', fullName: 'Ana Cliente', clientType: 'fixed',
      contacts: [{ id: 'contact-a', type: 'email', value: 'ana@example.com', preferred: true }],
      birthDate: null, documentNumber: null, status: 'active',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      operationalRules: { planMode: 'contract', recurrenceMode: 'reserved' },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requestedUrls.push(url)
      let body: unknown = authenticatedSession
      if (url.endsWith('/replacement-credits')) {
        body = { balance: 0, credits: [] }
      } else if (url.endsWith('/profile')) {
        body = {
          client,
          access: { schedule: true, plan: true, finance: true, history: true, clinical: true },
          schedule: [{
            id: 'appointment-a', participantId: 'participant-a', serviceName: 'Pilates', unitName: 'Centro',
            professionalName: 'Carla', professionalRegistrationNumber: 'CREFITO-3/12345-F', startsAt: '2026-09-02T13:00:00Z',
            endsAt: '2026-09-02T14:00:00Z', status: 'scheduled', participantStatus: 'confirmed',
          }],
          plan: [{
            id: 'contract-a', name: 'Mensal', startsOn: '2026-09-01', endsOn: null,
            status: 'active', agreedPriceCents: 25000, currency: 'BRL',
          }],
          finance: { openBalanceCents: 25000, receivables: [] },
          history: [{
            id: 'event-a', action: 'client.created', minimalMetadata: {},
            occurredAt: '2026-09-01T12:00:00Z',
          }],
          clinicalRecords: [{
            id: 'clinical-a',
            recordType: 'evolucao',
            content: 'Evolução de fortalecimento e flexibilidade.',
            occurredAt: '2026-09-02T14:00:00Z',
            signedAt: '2026-09-02T14:05:00Z',
            authorProfessional: {
              id: 'prof-a',
              displayName: 'Dra. Carla',
              registrationNumber: 'CREFITO-3/12345-F',
            },
          }],
        }
      } else if (url.includes('/clients')) {
        body = {
          items: [client],
          pagination: { page: url.includes('page=2') ? 2 : 1, pageSize: 20, total: 21, totalPages: 2 },
        }
      }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#clients'
    render(<App />)

    expect(await screen.findByText('Ana Cliente')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Buscar por nome ou contato'), { target: { value: 'ana' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))
    await waitFor(() => expect(requestedUrls.some((url) => url.includes('q=ana'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
    await waitFor(() => expect(requestedUrls.some((url) => url.includes('page=2'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Ver perfil' }))
    expect(await screen.findByRole('heading', { name: 'Perfil de Ana Cliente' })).toBeInTheDocument()
    expect(screen.getByText('Pilates')).toBeInTheDocument()
    expect(screen.getByText('Mensal')).toBeInTheDocument()
    expect(screen.getByText(/Saldo em aberto/)).toHaveTextContent('R$ 250,00')
    expect(screen.getByText('client.created')).toBeInTheDocument()
    expect(screen.getByText('0 créditos disponíveis')).toBeInTheDocument()
    expect(screen.getByText('Prontuário e Evoluções Clínicas')).toBeInTheDocument()
    expect(screen.getByText('Evolução de fortalecimento e flexibilidade.')).toBeInTheDocument()
    expect(screen.getAllByText(/CREFITO-3\/12345-F/).length).toBeGreaterThanOrEqual(1)
  })

  it('navega para contas a receber e apresenta o estado vazio', async () => {
    window.location.hash = '#dashboard'
    render(<App />)

    const navigationLink = await screen.findByRole('link', { name: 'Financeiro' })
    fireEvent.click(navigationLink)

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Contas a receber' }),
      ).toBeInTheDocument()
    })
    expect(navigationLink).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Nenhuma conta encontrada')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Nova conta' })).toHaveLength(2)
  })

  it('cadastra e converte uma prospecção sem perder o vínculo do funil', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    let items: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      let body: unknown = authenticatedSession
      let status = 200
      if (url.includes('/prospects') && method === 'GET') {
        body = {
          items,
          owners: [{ id: 'aaaaaaaa-4000-4000-8000-000000000001', displayName: 'Carla' }],
          stageCounts: { new: items.length },
          pagination: { page: 1, pageSize: 50, total: items.length, totalPages: items.length ? 1 : 0 },
        }
      }
      if (url.endsWith('/prospects') && method === 'POST') {
        const submitted = JSON.parse(String(init?.body))
        const created = {
          id: 'aaaaaaaa-9000-4000-8000-000000000001', ...submitted,
          owner: { id: submitted.ownerProfessionalId, displayName: 'Carla' },
          contacts: submitted.contacts.map((contact: object, index: number) => ({ id: `contact-${index}`, ...contact })),
          convertedAt: null, convertedClientId: null, interactions: [],
          createdAt: '2026-09-02T12:00:00Z', updatedAt: '2026-09-02T12:00:00Z',
        }
        items = [created]
        body = created
        status = 201
      }
      if (url.endsWith('/convert') && method === 'POST') {
        const prospect = { ...(items[0] as object), stage: 'converted', convertedClientId: 'client-a' }
        items = [prospect]
        body = { created: true, prospect, client: { id: 'client-a', fullName: 'Ana Interessada' } }
        status = 201
      }
      return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#leads'
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Nova prospecção' }))
    fireEvent.change(screen.getByLabelText('Nome completo'), { target: { value: 'Ana Interessada' } })
    fireEvent.change(screen.getByLabelText('Origem'), { target: { value: 'Indicação' } })
    fireEvent.change(screen.getByLabelText('Responsável'), {
      target: { value: 'aaaaaaaa-4000-4000-8000-000000000001' },
    })
    fireEvent.change(screen.getByLabelText('Telefone com DDD'), { target: { value: '(47) 99999-0000' } })
    fireEvent.change(screen.getByLabelText('Data da próxima ação'), { target: { value: '2026-09-10T14:00' } })
    fireEvent.change(screen.getByLabelText('Próxima ação'), { target: { value: 'Confirmar aula' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cadastrar prospecção' })[0])

    expect(await screen.findByText('Prospecção cadastrada com sucesso.')).toBeInTheDocument()
    expect(await screen.findByText('Ana Interessada')).toBeInTheDocument()
    const createRequest = requests.find(({ url, method }) => url.endsWith('/prospects') && method === 'POST')
    expect(JSON.parse(createRequest?.body ?? '{}')).toMatchObject({
      fullName: 'Ana Interessada', source: 'Indicação', stage: 'new',
      ownerProfessionalId: 'aaaaaaaa-4000-4000-8000-000000000001',
      nextActionNote: 'Confirmar aula',
      contacts: [{ type: 'phone', value: '(47) 99999-0000', preferred: true }],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Converter em cliente' }))
    fireEvent.click(screen.getByLabelText(/Fixo/))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conversão' }))
    expect(await screen.findByText('Prospecção convertida em cliente. O histórico foi preservado.')).toBeInTheDocument()
    expect(requests.some(({ url, method }) => url.endsWith('/convert') && method === 'POST')).toBe(true)
  })

  it('mostra o funil em colunas e volta do contato para o histórico', async () => {
    const prospect = {
      id: 'aaaaaaaa-9000-4000-8000-000000000001',
      fullName: 'Ana Interessada',
      source: 'Indicação',
      stage: 'contacted',
      owner: null,
      contacts: [],
      nextActionAt: null,
      nextActionNote: null,
      convertedAt: null,
      convertedClientId: null,
      interactions: [{ id: 'interaction-1', type: 'call', notes: 'Ligou de manhã', occurredAt: '2026-09-02T12:00:00Z' }],
      createdAt: '2026-09-02T12:00:00Z',
      updatedAt: '2026-09-02T12:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/prospects/')
        ? prospect
        : url.includes('/prospects')
          ? {
            items: [prospect],
            owners: [],
            stageCounts: { contacted: 1 },
            pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
          }
          : authenticatedSession
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#leads'
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Funil de prospecções' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Contatada' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Qualificada' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Qualificada/ }))
    expect(await screen.findByRole('heading', { name: 'Qualificada' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Contatada' })).not.toBeInTheDocument()
    expect(screen.queryByText('Ana Interessada')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Todas as etapas' }))
    expect(await screen.findByRole('heading', { name: 'Contatada' })).toBeInTheDocument()
    expect(screen.getByText('Ana Interessada')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Histórico' }))

    expect(await screen.findByRole('heading', { name: 'Histórico de Ana Interessada' })).toBeInTheDocument()
    expect(screen.getByText('Ligou de manhã')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Funil de prospecções' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Registrar contato' }))

    expect(screen.getByRole('heading', { name: 'Registrar contato de Ana Interessada' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Histórico de Ana Interessada' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para o histórico' }))
    expect(screen.getByRole('heading', { name: 'Histórico de Ana Interessada' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para o funil' }))
    expect(screen.getByRole('region', { name: 'Funil de prospecções' })).toBeInTheDocument()
  })

  it('cadastra e inativa recursos operacionais preservando associações', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    let modalities: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      let body: unknown = authenticatedSession
      let status = 200
      if (url.includes('/resources') && method === 'GET') {
        body = {
          modalities, services: [], rooms: [], equipment: [],
          units: [{ id: 'unit-a', name: 'Centro', active: true }],
        }
      }
      if (url.endsWith('/resources/modalities') && method === 'POST') {
        const submitted = JSON.parse(String(init?.body))
        const created = {
          id: 'modality-a', ...submitted, associationsCount: 0,
          createdAt: '2026-09-02T12:00:00Z', updatedAt: '2026-09-02T12:00:00Z',
        }
        modalities = [created]
        body = created
        status = 201
      }
      if (url.endsWith('/resources/modalities/modality-a') && method === 'PUT') {
        const submitted = JSON.parse(String(init?.body))
        modalities = [{ ...modalities[0], ...submitted }]
        body = modalities[0]
      }
      return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#resources'
    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Recursos operacionais' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Modalidades/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Novo recurso' })[0])
    expect(screen.getByRole('button', { name: 'Voltar para os recursos' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist', { name: 'Tipos de recurso' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pilates clínico' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar recurso' }))
    expect(await screen.findByText('Modalidade cadastrada com sucesso.')).toBeInTheDocument()
    expect(await screen.findByText('Pilates clínico')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Inativar' }))
    expect(await screen.findByText('Pilates clínico foi inativada.')).toBeInTheDocument()
    const update = requests.find(({ url, method }) => url.endsWith('/modalities/modality-a') && method === 'PUT')
    expect(JSON.parse(update?.body ?? '{}')).toEqual({ name: 'Pilates clínico', active: false })
    expect(screen.getByText('Inativo')).toBeInTheDocument()
  })

  it('abre a gestão da organização autenticada', async () => {
    window.location.hash = '#dashboard'
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: 'Mais' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Organização e equipe' })).toBeInTheDocument()
    expect(screen.getByText('Clínica Serena · Proprietário')).toBeInTheDocument()
  })

  it('separa a área do cliente, lista somente suas ações e conclui o check-in', async () => {
    const clientSession = {
      user: { id: 'client-user', email: 'cliente@example.com' },
      organizationId: 'org-a',
      organizations: [{
        id: 'org-a', name: 'Clínica Serena', roleCode: 'client', roleName: 'Cliente',
        permissions: ['clients.own.read', 'schedule.own.read', 'schedule.own.manage', 'clinical.published.read'],
      }],
      expiresAt: '2099-09-02T00:00:00.000Z',
    }
    const appointment = {
      id: 'appointment-a', participantId: 'participant-a',
      startsAt: '2099-09-02T13:00:00.000Z', endsAt: '2099-09-02T13:50:00.000Z',
      status: 'scheduled', participantStatus: 'confirmed',
      service: { id: 'service-a', name: 'Pilates clínico' },
      professional: { id: 'professional-a', displayName: 'Dra. Marina' },
      unit: { id: 'unit-a', name: 'Unidade Centro', timezone: 'America/Sao_Paulo' },
      room: { id: 'room-a', name: 'Sala 1' }, checkedInAt: null,
      checkIn: {
        allowed: true, reason: null,
        opensAt: '2099-09-02T12:30:00.000Z', closesAt: '2099-09-02T13:15:00.000Z',
      },
    }
    const offeredAppointment = {
      ...appointment,
      id: 'class-full', participantId: 'participant-waitlist',
      startsAt: '2099-09-03T13:00:00.000Z', endsAt: '2099-09-03T13:50:00.000Z',
      service: { id: 'service-a', name: 'Pilates em grupo' },
      checkIn: { ...appointment.checkIn, allowed: false, reason: 'too_early' as const },
    }
    const replacementAppointment = {
      ...offeredAppointment,
      id: 'class-replacement', participantId: 'participant-replacement',
      startsAt: '2099-09-04T13:00:00.000Z', endsAt: '2099-09-04T13:50:00.000Z',
      service: { id: 'service-a', name: 'Turma para reposição' },
      replacementCreditId: 'credit-a',
    }
    let joinedWaitlist = false
    let confirmedWaitlist = false
    let bookedReplacement = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      let body: unknown = clientSession
      if (url.endsWith('/client-area')) body = {
        client: {
          id: 'client-a', fullName: 'Ana Cliente', birthDate: null,
          clientType: 'fixed', status: 'active', contacts: [],
        },
        organization: { id: 'org-a', name: 'Clínica Serena' },
        checkInPolicy: { enabled: true, beforeMinutes: 30, afterMinutes: 15 },
        nextAppointment: appointment,
      }
      if (url.endsWith('/client-area/appointments')) body = {
        appointments: [appointment,
          ...(confirmedWaitlist ? [offeredAppointment] : []),
          ...(bookedReplacement ? [replacementAppointment] : [])],
      }
      if (url.endsWith('/client-area/waitlist')) body = {
        entries: joinedWaitlist && !confirmedWaitlist ? [{
          id: 'entry-a', appointment: offeredAppointment, status: 'offered', position: 1,
          queuedAt: '2099-09-01T10:00:00.000Z',
          offer: {
            id: 'offer-a', status: 'active', offeredAt: '2099-09-01T11:00:00.000Z',
            expiresAt: '2099-09-03T12:55:00.000Z',
          },
        }] : [],
        eligibleAppointments: joinedWaitlist ? [] : [{
          id: 'class-full', startsAt: '2099-09-03T13:00:00.000Z',
          endsAt: '2099-09-03T13:50:00.000Z', capacity: 4, occupancy: 4,
          service: { id: 'service-a', name: 'Pilates em grupo' },
          professional: { id: 'professional-a', displayName: 'Dra. Marina' },
          unit: { id: 'unit-a', name: 'Unidade Centro', timezone: 'America/Sao_Paulo' },
          room: { id: 'room-a', name: 'Sala 1' },
        }],
      }
      if (url.endsWith('/client-area/replacement-credits')) body = {
        balance: bookedReplacement ? 0 : 1,
        credits: [],
        eligibleAppointments: bookedReplacement ? [] : [{
          id: replacementAppointment.id,
          startsAt: replacementAppointment.startsAt, endsAt: replacementAppointment.endsAt,
          capacity: 4, occupancy: 2, service: replacementAppointment.service,
          professional: replacementAppointment.professional, unit: replacementAppointment.unit,
          room: replacementAppointment.room,
        }],
      }
      if (url.endsWith('/client-area/clinical-content')) body = {
        workoutPlans: [{
          id: 'workout-a', title: 'Mobilidade diária',
          instructions: { Frequência: '3 vezes por semana' }, validUntil: '2099-12-31',
          createdAt: '2099-08-01T12:00:00.000Z',
          professional: { id: 'professional-a', displayName: 'Dra. Marina' },
        }],
        assessments: [{
          id: 'assessment-a', type: 'Avaliação funcional', data: { Mobilidade: 'Boa' },
          assessedAt: '2099-08-20T12:00:00.000Z',
          professional: { id: 'professional-a', displayName: 'Dra. Marina' },
        }],
      }
      if (url.endsWith('/client-area/contact')) body = {
        channels: [{
          id: 'contact-a', channel: 'whatsapp', label: 'WhatsApp da clínica',
          displayValue: '+5547999990000', href: 'https://wa.me/5547999990000',
        }],
      }
      if (url.endsWith('/interest') && init?.method === 'POST') {
        joinedWaitlist = true
        body = { id: 'entry-a' }
      }
      if (url.endsWith('/waitlist/confirm') && init?.method === 'POST') {
        confirmedWaitlist = true
        body = offeredAppointment
      }
      if (url.endsWith('/replacement') && init?.method === 'POST') {
        bookedReplacement = true
        body = replacementAppointment
      }
      if (url.endsWith('/check-in') && init?.method === 'POST') body = {
        ...appointment, checkedInAt: '2099-09-02T12:45:00.000Z',
        checkIn: { ...appointment.checkIn, allowed: false, reason: 'already_checked_in' },
      }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    window.location.hash = '#dashboard'
    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Ana!' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Navegação da área do cliente' })).toBeInTheDocument()
    expect(screen.getByText('Pilates clínico')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fazer check-in' }))
    expect(await screen.findByText('Check-in realizado. Sua chegada foi registrada.')).toBeInTheDocument()
    expect(screen.getByText('Check-in realizado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Agendamentos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Tenho interesse' }))
    expect(await screen.findByText('Interesse registrado. Você será avisado quando chegar a sua vez.')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar vaga' }))
    expect(await screen.findByText('Vaga confirmada. A turma foi adicionada aos seus agendamentos.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirmar vaga' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Usar reposição' }))
    expect(await screen.findByText('Reposição agendada. Um crédito foi utilizado com segurança.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Usar reposição' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Conteúdos' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Treinos e avaliações' })).toBeInTheDocument()
    expect(screen.getByText('Mobilidade diária')).toBeInTheDocument()
    expect(screen.getByText('Avaliação funcional')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Contato' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Contato' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /WhatsApp da clínica/ })).toHaveAttribute('href', 'https://wa.me/5547999990000')
  })
})
