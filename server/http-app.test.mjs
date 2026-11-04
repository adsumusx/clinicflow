// @vitest-environment node
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createHttpHandler } from './http-app.mjs'

function makeRequest({ method = 'GET', url, body, headers = {} }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.url = url
  request.headers = {
    host: 'clinicflow.test',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  }
  request.socket = { encrypted: false, remoteAddress: '127.0.0.1' }
  return request
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    payload: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.payload = payload === undefined ? undefined : JSON.parse(payload)
    },
  }
}

describe('rotas HTTP de clientes', () => {
  it('encaminha busca, filtro e paginação na listagem', async () => {
    const service = { listClients: vi.fn(async () => ({ items: [], pagination: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients?type=fixed&q=ana&page=2&pageSize=10',
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listClients).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { clientType: 'fixed', search: 'ana', page: '2', pageSize: '10' },
    )
  })

  it('encaminha a rota de perfil sem confundi-la com o cadastro', async () => {
    const profile = { client: { id: 'aaaaaaaa-5000-4000-8000-000000000001' } }
    const service = { getClientProfile: vi.fn(async () => profile) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients/aaaaaaaa-5000-4000-8000-000000000001/profile',
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(response.payload).toEqual(profile)
    expect(service.getClientProfile).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-5000-4000-8000-000000000001',
    )
  })

  it('encaminha prontuário clínico e atualização de registro profissional com proteção de origem', async () => {
    const records = { items: [{ id: 'record-1', recordType: 'evolucao', content: 'Paciente atendido', authorProfessional: { displayName: 'Dr. Teste', registrationNumber: 'CREFITO-3/12345-F' } }] }
    const service = {
      listClientClinicalRecords: vi.fn(async () => records),
      createClientClinicalRecord: vi.fn(async () => records.items[0]),
      updateProfessional: vi.fn(async () => ({ id: 'prof-1', registrationNumber: 'CREFITO-3/99999-F' })),
    }
    const handler = createHttpHandler(service)

    const listRes = makeResponse()
    await handler(makeRequest({
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients/aaaaaaaa-5000-4000-8000-000000000001/clinical-records',
      headers: { cookie: 'clinicflow_session=session-token' },
    }), listRes)
    expect(listRes.status).toBe(200)
    expect(listRes.payload).toEqual(records)

    const createRes = makeResponse()
    await handler(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients/aaaaaaaa-5000-4000-8000-000000000001/clinical-records',
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://localhost:3000', host: 'localhost:3000' },
      body: { content: 'Nova evolução', recordType: 'evolucao' },
    }), createRes)
    expect(createRes.status).toBe(201)
    expect(service.createClientClinicalRecord).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-5000-4000-8000-000000000001',
      { content: 'Nova evolução', recordType: 'evolucao' },
    )

    const patchRes = makeResponse()
    await handler(makeRequest({
      method: 'PATCH',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/professionals/aaaaaaaa-4000-4000-8000-000000000001',
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://localhost:3000', host: 'localhost:3000' },
      body: { registrationNumber: 'CREFITO-3/99999-F' },
    }), patchRes)
    expect(patchRes.status).toBe(200)
    expect(service.updateProfessional).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-4000-4000-8000-000000000001',
      { registrationNumber: 'CREFITO-3/99999-F' },
    )
  })

  it('bloqueia mutação vinda de outra origem antes do serviço', async () => {
    const service = { createClient: vi.fn() }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients',
      body: { fullName: 'Ana Silva' },
      headers: { origin: 'https://malicioso.example', 'sec-fetch-site': 'cross-site' },
    }), response)

    expect(response.status).toBe(403)
    expect(response.payload).toEqual({
      error: { code: 'ORIGIN_FORBIDDEN', message: 'Origem da solicitação não permitida.' },
    })
    expect(service.createClient).not.toHaveBeenCalled()
  })

  it('aceita mutação same-origin quando o proxy reescreve o host da API', async () => {
    const service = { createClient: vi.fn(async () => ({ id: 'client-a' })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients',
      body: { fullName: 'Ana Silva' },
      headers: {
        origin: 'http://localhost:5173',
        host: 'localhost:3001',
        'sec-fetch-site': 'same-origin',
      },
    }), response)

    expect(response.status).toBe(201)
    expect(service.createClient).toHaveBeenCalled()
  })

  it('bloqueia origem divergente sem o sinal same-origin do navegador', async () => {
    const service = { createClient: vi.fn() }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients',
      body: { fullName: 'Ana Silva' },
      headers: { origin: 'https://malicioso.example', host: 'clinicflow.test' },
    }), response)

    expect(response.status).toBe(403)
    expect(response.payload).toEqual({
      error: { code: 'ORIGIN_FORBIDDEN', message: 'Origem da solicitação não permitida.' },
    })
    expect(service.createClient).not.toHaveBeenCalled()
  })

  it('encaminha JSON da mesma origem e não expõe cache', async () => {
    const created = { id: 'client-a', fullName: 'Ana Silva', contacts: [] }
    const service = { createClient: vi.fn(async () => created) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/clients',
      body: { fullName: 'Ana Silva', contacts: [] },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(201)
    expect(service.createClient).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { fullName: 'Ana Silva', contacts: [] },
    )
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(response.payload).toEqual(created)
  })
})

describe('rotas HTTP de relatórios', () => {
  const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001'

  it('encaminha os mesmos filtros para tela e paginação', async () => {
    const service = { listBirthdayReport: vi.fn(async () => ({ items: [], pagination: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/birthdays?from=2026-09-01&to=2026-09-30&status=active&page=2&pageSize=25`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listBirthdayReport).toHaveBeenCalledWith(
      'session-token', organizationId,
      expect.objectContaining({
        from: '2026-09-01', to: '2026-09-30', status: 'active', page: '2', pageSize: '25',
      }),
    )
  })

  it('entrega a exportação como anexo CSV sem cache', async () => {
    const service = {
      exportBirthdayReport: vi.fn(async () => ({
        filename: 'aniversariantes-2026-09.csv', content: '\uFEFF"Data"\r\n',
      })),
    }
    const response = {
      status: 0,
      headers: {},
      payload: '',
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(payload) { this.payload = payload },
    }
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/birthdays/export?from=2026-09-01&to=2026-09-30`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="aniversariantes-2026-09.csv"',
      'Cache-Control': 'no-store',
    })
    expect(response.payload).toContain('Data')
  })

  it('encaminha visão geral ou fixa para o relatório de clientes', async () => {
    const service = { listClientReport: vi.fn(async () => ({ items: [], pagination: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/clients?from=2026-09-01&to=2026-09-30&clientType=fixed`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listClientReport).toHaveBeenCalledWith(
      'session-token', organizationId, expect.objectContaining({ clientType: 'fixed' }),
    )
  })

  it('encaminha agrupamento e bucket para o drill-down de atividade', async () => {
    const service = { listClientActivityReport: vi.fn(async () => ({ items: [], details: [] })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/client-activity?from=2026-01-01&to=2026-12-31&granularity=month&bucket=2026-09`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listClientActivityReport).toHaveBeenCalledWith(
      'session-token', organizationId,
      expect.objectContaining({ granularity: 'month', bucket: '2026-09' }),
    )
  })

  it('encaminha filtros ao dashboard de negócio', async () => {
    const service = { getBusinessDashboardReport: vi.fn(async () => ({ financial: {}, operational: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/dashboard?from=2026-09-01&to=2026-09-30&unitId=aaaaaaaa-1000-4000-8000-000000000001`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.getBusinessDashboardReport).toHaveBeenCalledWith(
      'session-token', organizationId,
      expect.objectContaining({
        from: '2026-09-01', to: '2026-09-30',
        unitId: 'aaaaaaaa-1000-4000-8000-000000000001',
      }),
    )
  })

  it('encaminha modalidade e paginação ao relatório de aparelhos', async () => {
    const service = { listEquipmentUsageReport: vi.fn(async () => ({ items: [], pagination: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/equipment-usage?from=2026-09-01&to=2026-09-30&modalityId=aaaaaaaa-6000-4000-8000-000000000001&page=2`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listEquipmentUsageReport).toHaveBeenCalledWith(
      'session-token', organizationId,
      expect.objectContaining({
        modalityId: 'aaaaaaaa-6000-4000-8000-000000000001', page: '2',
      }),
    )
  })

  it('encaminha filtros e paginação ao relatório de prospecções', async () => {
    const service = { listProspectReport: vi.fn(async () => ({ items: [], pagination: {} })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/reports/prospects?from=2026-09-01&to=2026-09-30&professionalId=aaaaaaaa-4000-4000-8000-000000000001&page=2&pageSize=10`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listProspectReport).toHaveBeenCalledWith(
      'session-token', organizationId,
      expect.objectContaining({
        professionalId: 'aaaaaaaa-4000-4000-8000-000000000001', page: '2', pageSize: '10',
      }),
    )
  })
})

describe('rotas HTTP de contas a receber', () => {
  const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001'
  const receivableId = 'aaaaaaaa-7300-4000-8000-000000000001'

  it('encaminha filtros e paginação da listagem', async () => {
    const service = { listReceivables: vi.fn(async () => ({ items: [] })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `/api/organizations/${organizationId}/receivables?status=overdue&q=mensal&page=2&pageSize=10`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listReceivables).toHaveBeenCalledWith('session-token', organizationId, {
      status: 'overdue', search: 'mensal', dueFrom: undefined, dueTo: undefined,
      page: '2', pageSize: '10',
    })
  })

  it('encaminha criação e cancelamento somente pela fronteira protegida', async () => {
    const service = {
      createReceivable: vi.fn(async () => ({ items: [] })),
      cancelReceivable: vi.fn(async () => ({ id: receivableId, status: 'cancelled' })),
    }
    const handler = createHttpHandler(service)
    const createResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${organizationId}/receivables`,
      body: { description: 'Mensalidade' },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), createResponse)
    const cancelResponse = makeResponse()
    await handler(makeRequest({
      method: 'DELETE', url: `/api/organizations/${organizationId}/receivables/${receivableId}`,
      body: { reason: 'Cobrança indevida' },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), cancelResponse)

    expect(createResponse.status).toBe(201)
    expect(cancelResponse.status).toBe(200)
    expect(service.cancelReceivable).toHaveBeenCalledWith(
      'session-token', organizationId, receivableId, { reason: 'Cobrança indevida' },
    )
  })

  it('encaminha recebimentos, estornos e contas a pagar', async () => {
    const paymentId = 'aaaaaaaa-7400-4000-8000-000000000001'
    const payableId = 'aaaaaaaa-7500-4000-8000-000000000001'
    const service = {
      createReceivablePayment: vi.fn(async () => ({ replayed: false })),
      reverseReceivablePayment: vi.fn(async () => ({ replayed: false })),
      listPayables: vi.fn(async () => ({ items: [] })),
      createPayablePayment: vi.fn(async () => ({ replayed: false })),
    }
    const handler = createHttpHandler(service)
    const headers = { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' }
    const receipt = { amountCents: 10000, method: 'pix' }
    const reversal = { reason: 'Duplicado' }
    const receiptResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${organizationId}/receivables/${receivableId}/payments`,
      body: receipt, headers,
    }), receiptResponse)
    const reversalResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${organizationId}/receivables/${receivableId}/payments/${paymentId}/reversal`,
      body: reversal, headers,
    }), reversalResponse)
    const payablesResponse = makeResponse()
    await handler(makeRequest({
      url: `/api/organizations/${organizationId}/payables?status=open&page=1&pageSize=20`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), payablesResponse)
    const payablePaymentResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${organizationId}/payables/${payableId}/payments`,
      body: receipt, headers,
    }), payablePaymentResponse)

    expect(receiptResponse.status).toBe(201)
    expect(reversalResponse.status).toBe(201)
    expect(payablesResponse.status).toBe(200)
    expect(payablePaymentResponse.status).toBe(201)
    expect(service.reverseReceivablePayment).toHaveBeenCalledWith(
      'session-token', organizationId, receivableId, paymentId, reversal,
    )
    expect(service.listPayables).toHaveBeenCalledWith('session-token', organizationId, {
      status: 'open', search: undefined, dueFrom: undefined, dueTo: undefined,
      page: '1', pageSize: '20',
    })
  })
})

describe('rotas HTTP de prospecções', () => {
  it('encaminha etapa, busca e paginação do funil', async () => {
    const service = {
      listProspects: vi.fn(async () => ({ items: [], owners: [], stageCounts: {}, pagination: {} })),
    }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/prospects?stage=qualified&q=ana&page=2&pageSize=10',
      headers: { cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.listProspects).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { stage: 'qualified', search: 'ana', page: '2', pageSize: '10' },
    )
  })

  it('converte com proteção de origem e diferencia a primeira execução da repetição', async () => {
    const service = { convertProspect: vi.fn(async () => ({ created: true, client: { id: 'client-a' } })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/prospects/aaaaaaaa-9000-4000-8000-000000000001/convert',
      body: { clientType: 'fixed' },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), response)

    expect(response.status).toBe(201)
    expect(service.convertProspect).toHaveBeenCalledWith(
      'session-token',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-9000-4000-8000-000000000001',
      { clientType: 'fixed' },
    )

    service.convertProspect.mockResolvedValueOnce({ created: false, client: { id: 'client-a' } })
    const repeatedResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/prospects/aaaaaaaa-9000-4000-8000-000000000001/convert',
      body: { clientType: 'rotating' },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), repeatedResponse)
    expect(repeatedResponse.status).toBe(200)
    expect(repeatedResponse.payload).toMatchObject({ created: false, client: { id: 'client-a' } })
  })
})

describe('rotas HTTP de recursos', () => {
  it('lista por situação e encaminha criação e atualização protegidas por origem', async () => {
    const service = {
      listResources: vi.fn(async () => ({ services: [] })),
      createResource: vi.fn(async () => ({ id: 'service-a' })),
      updateResource: vi.fn(async () => ({ id: 'aaaaaaaa-6100-4000-8000-000000000001', active: false })),
    }
    const organizationPath = '/api/organizations/aaaaaaaa-0000-4000-8000-000000000001/resources'
    const listResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `${organizationPath}?status=inactive`, headers: { cookie: 'clinicflow_session=session-token' },
    }), listResponse)
    expect(listResponse.status).toBe(200)
    expect(service.listResources).toHaveBeenCalledWith(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001', { status: 'inactive' },
    )

    const createResponse = makeResponse()
    const input = { name: 'Pilates', modalityId: 'modality-a', durationMinutes: 50, defaultCapacity: 1 }
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${organizationPath}/services`, body: input,
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), createResponse)
    expect(createResponse.status).toBe(201)
    expect(service.createResource).toHaveBeenCalledWith(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001', 'services', input,
    )

    const updateResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'PUT', url: `${organizationPath}/equipment/aaaaaaaa-6250-4000-8000-000000000001`,
      body: { name: 'Reformer', active: false },
      headers: { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' },
    }), updateResponse)
    expect(updateResponse.status).toBe(200)
    expect(service.updateResource).toHaveBeenCalledWith(
      'session-token', 'aaaaaaaa-0000-4000-8000-000000000001', 'equipment',
      'aaaaaaaa-6250-4000-8000-000000000001', { name: 'Reformer', active: false },
    )
  })
})

describe('rotas HTTP de agenda', () => {
  it('encaminha disponibilidade e o ciclo do agendamento com proteção de origem', async () => {
    const service = {
      getSchedule: vi.fn(async () => ({ appointments: [] })),
      createAvailability: vi.fn(async () => ({ id: 'rule-a' })),
      createAppointment: vi.fn(async () => ({ id: 'appointment-a' })),
      createClassAppointment: vi.fn(async () => ({ id: 'class-a' })),
      addAppointmentParticipant: vi.fn(async () => ({ id: 'class-a', occupancy: 2 })),
      cancelAppointmentParticipant: vi.fn(async () => ({ id: 'class-a', occupancy: 1 })),
      createAppointmentSeries: vi.fn(async () => ({ id: 'series-a', appointments: [] })),
      updateAppointmentOccurrences: vi.fn(async () => ({ scope: 'future', appointments: [] })),
      updateAppointment: vi.fn(async () => ({ id: 'aaaaaaaa-6300-4000-8000-000000000001' })),
      cancelAppointment: vi.fn(async () => ({ id: 'aaaaaaaa-6300-4000-8000-000000000001', status: 'cancelled' })),
    }
    const organization = 'aaaaaaaa-0000-4000-8000-000000000001'
    const base = `/api/organizations/${organization}`
    const headers = { origin: 'http://clinicflow.test', cookie: 'clinicflow_session=session-token' }

    const listResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      url: `${base}/appointments?from=2026-09-01T03%3A00%3A00.000Z&to=2026-09-02T03%3A00%3A00.000Z`,
      headers,
    }), listResponse)
    expect(listResponse.status).toBe(200)
    expect(service.getSchedule).toHaveBeenCalledWith('session-token', organization, {
      from: '2026-09-01T03:00:00.000Z', to: '2026-09-02T03:00:00.000Z', professionalId: undefined,
    })

    const rule = { kind: 'working_hours', weekday: 2 }
    const ruleResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${base}/availability-rules`, body: rule, headers,
    }), ruleResponse)
    expect(ruleResponse.status).toBe(201)
    expect(service.createAvailability).toHaveBeenCalledWith('session-token', organization, rule)

    const input = { startsAt: '2026-09-08T10:00:00-03:00' }
    const createResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${base}/appointments`, body: input, headers,
    }), createResponse)
    expect(createResponse.status).toBe(201)
    expect(service.createAppointment).toHaveBeenCalledWith('session-token', organization, input)

    const classResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${base}/appointments/classes`, body: { capacity: 4 }, headers,
    }), classResponse)
    expect(classResponse.status).toBe(201)
    expect(service.createClassAppointment).toHaveBeenCalledWith(
      'session-token', organization, { capacity: 4 },
    )

    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const participantResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${base}/appointments/${appointmentId}/participants`,
      body: { clientId }, headers,
    }), participantResponse)
    expect(participantResponse.status).toBe(201)
    expect(service.addAppointmentParticipant).toHaveBeenCalledWith(
      'session-token', organization, appointmentId, { clientId },
    )

    const seriesResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST', url: `${base}/appointment-series`, body: { recurrence: { count: 4 } }, headers,
    }), seriesResponse)
    expect(seriesResponse.status).toBe(201)
    expect(service.createAppointmentSeries).toHaveBeenCalled()

    const futureResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'PUT', url: `${base}/appointments/${appointmentId}/occurrences`,
      body: { scope: 'future' }, headers,
    }), futureResponse)
    expect(futureResponse.status).toBe(200)
    expect(service.updateAppointmentOccurrences).toHaveBeenCalledWith(
      'session-token', organization, appointmentId, { scope: 'future' },
    )

    const cancelResponse = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'DELETE', url: `${base}/appointments/${appointmentId}`, headers,
    }), cancelResponse)
    expect(cancelResponse.status).toBe(200)
    expect(service.cancelAppointment).toHaveBeenCalledWith('session-token', organization, appointmentId)
  })
})

describe('rotas HTTP da área do cliente', () => {
  it('encaminha início, agendamentos próprios e check-in protegido por origem', async () => {
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const organization = 'aaaaaaaa-0000-4000-8000-000000000001'
    const base = `/api/organizations/${organization}/client-area`
    const service = {
      getClientArea: vi.fn(async () => ({ client: { id: 'client-a' } })),
      getOwnPublishedClinicalContent: vi.fn(async () => ({ assessments: [], workoutPlans: [] })),
      getOwnContactChannels: vi.fn(async () => ({ channels: [] })),
      getOwnAppointments: vi.fn(async () => ({ appointments: [] })),
      getOwnWaitlist: vi.fn(async () => ({ entries: [], eligibleAppointments: [] })),
      joinOwnWaitlist: vi.fn(async () => ({ id: 'entry-a' })),
      leaveOwnWaitlist: vi.fn(async () => ({ id: 'entry-a', status: 'cancelled' })),
      confirmOwnWaitlistOffer: vi.fn(async () => ({ participantId: 'participant-a' })),
      getOwnReplacementCredits: vi.fn(async () => ({ balance: 1, credits: [], eligibleAppointments: [] })),
      bookOwnAppointmentWithReplacement: vi.fn(async () => ({ participantId: 'participant-r' })),
      selfCheckIn: vi.fn(async () => ({ id: appointmentId, checkedInAt: '2026-09-02T12:00:00Z' })),
    }
    const handler = createHttpHandler(service)
    const listResponse = makeResponse()
    await handler(makeRequest({
      url: `${base}/appointments`, headers: { cookie: 'clinicflow_session=session-token' },
    }), listResponse)
    expect(listResponse.status).toBe(200)
    expect(service.getOwnAppointments).toHaveBeenCalledWith('session-token', organization)

    const waitlistResponse = makeResponse()
    await handler(makeRequest({
      url: `${base}/waitlist`, headers: { cookie: 'clinicflow_session=session-token' },
    }), waitlistResponse)
    expect(waitlistResponse.status).toBe(200)
    expect(service.getOwnWaitlist).toHaveBeenCalledWith('session-token', organization)

    const homeResponse = makeResponse()
    await handler(makeRequest({ url: base, headers: { cookie: 'clinicflow_session=session-token' } }), homeResponse)
    expect(homeResponse.status).toBe(200)
    expect(service.getClientArea).toHaveBeenCalledWith('session-token', organization)

    const clinicalResponse = makeResponse()
    await handler(makeRequest({
      url: `${base}/clinical-content`, headers: { cookie: 'clinicflow_session=session-token' },
    }), clinicalResponse)
    expect(clinicalResponse.status).toBe(200)
    expect(service.getOwnPublishedClinicalContent).toHaveBeenCalledWith('session-token', organization)

    const contactResponse = makeResponse()
    await handler(makeRequest({
      url: `${base}/contact`, headers: { cookie: 'clinicflow_session=session-token' },
    }), contactResponse)
    expect(contactResponse.status).toBe(200)
    expect(service.getOwnContactChannels).toHaveBeenCalledWith('session-token', organization)

    const checkInResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `${base}/appointments/${appointmentId}/check-in`, body: {},
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), checkInResponse)
    expect(checkInResponse.status).toBe(200)
    expect(service.selfCheckIn).toHaveBeenCalledWith('session-token', organization, appointmentId)

    const interestResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `${base}/appointments/${appointmentId}/interest`, body: {},
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), interestResponse)
    expect(interestResponse.status).toBe(201)
    expect(service.joinOwnWaitlist).toHaveBeenCalledWith('session-token', organization, appointmentId)

    const leaveResponse = makeResponse()
    await handler(makeRequest({
      method: 'DELETE', url: `${base}/appointments/${appointmentId}/interest`,
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), leaveResponse)
    expect(leaveResponse.status).toBe(200)
    expect(service.leaveOwnWaitlist).toHaveBeenCalledWith('session-token', organization, appointmentId)

    const confirmationResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `${base}/appointments/${appointmentId}/waitlist/confirm`, body: {},
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), confirmationResponse)
    expect(confirmationResponse.status).toBe(200)
    expect(service.confirmOwnWaitlistOffer).toHaveBeenCalledWith(
      'session-token', organization, appointmentId,
    )

    const creditsResponse = makeResponse()
    await handler(makeRequest({
      url: `${base}/replacement-credits`,
      headers: { cookie: 'clinicflow_session=session-token' },
    }), creditsResponse)
    expect(creditsResponse.status).toBe(200)
    expect(service.getOwnReplacementCredits).toHaveBeenCalledWith('session-token', organization)

    const bookingResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `${base}/appointments/${appointmentId}/replacement`, body: {},
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), bookingResponse)
    expect(bookingResponse.status).toBe(201)
    expect(service.bookOwnAppointmentWithReplacement).toHaveBeenCalledWith(
      'session-token', organization, appointmentId,
    )
  })
})

describe('rotas HTTP de créditos de reposição', () => {
  it('lista, emite e cancela o crédito no escopo do cliente', async () => {
    const organization = 'aaaaaaaa-0000-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const creditId = 'aaaaaaaa-6500-4000-8000-000000000001'
    const sourceParticipantId = 'aaaaaaaa-6400-4000-8000-000000000001'
    const base = `/api/organizations/${organization}/clients/${clientId}/replacement-credits`
    const service = {
      listReplacementCredits: vi.fn(async () => ({ balance: 1, credits: [] })),
      issueReplacementCredit: vi.fn(async () => ({ id: creditId, status: 'available' })),
      cancelReplacementCredit: vi.fn(async () => ({ id: creditId, status: 'cancelled' })),
    }
    const handler = createHttpHandler(service)
    const headers = {
      cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test',
    }

    const listResponse = makeResponse()
    await handler(makeRequest({ url: base, headers }), listResponse)
    expect(listResponse.status).toBe(200)
    expect(service.listReplacementCredits).toHaveBeenCalledWith(
      'session-token', organization, clientId,
    )

    const issueResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: base,
      body: { sourceParticipantId, expiresOn: '2026-10-15' }, headers,
    }), issueResponse)
    expect(issueResponse.status).toBe(201)
    expect(service.issueReplacementCredit).toHaveBeenCalledWith(
      'session-token', organization, clientId,
      { sourceParticipantId, expiresOn: '2026-10-15' },
    )

    const cancelResponse = makeResponse()
    await handler(makeRequest({ method: 'DELETE', url: `${base}/${creditId}`, headers }), cancelResponse)
    expect(cancelResponse.status).toBe(200)
    expect(service.cancelReplacementCredit).toHaveBeenCalledWith(
      'session-token', organization, clientId, creditId,
    )
  })
})

describe('rota HTTP de avanço da fila', () => {
  it('protege a mutação por origem e encaminha a turma ao serviço', async () => {
    const organization = 'aaaaaaaa-0000-4000-8000-000000000001'
    const appointmentId = 'aaaaaaaa-6300-4000-8000-000000000001'
    const service = { advanceWaitlistOffer: vi.fn(async () => ({ id: 'offer-a' })) }
    const response = makeResponse()
    await createHttpHandler(service)(makeRequest({
      method: 'POST',
      url: `/api/organizations/${organization}/appointments/${appointmentId}/waitlist/advance`,
      body: {},
      headers: { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' },
    }), response)

    expect(response.status).toBe(200)
    expect(service.advanceWaitlistOffer).toHaveBeenCalledWith(
      'session-token', organization, appointmentId,
    )
  })
})

describe('rotas HTTP de push', () => {
  it('registra, revoga e altera preferência com proteção de origem', async () => {
    const organization = 'aaaaaaaa-0000-4000-8000-000000000001'
    const deviceId = 'aaaaaaaa-9000-4000-8000-000000000001'
    const service = {
      registerPushDevice: vi.fn(async () => ({ id: deviceId, platform: 'web' })),
      revokePushDevice: vi.fn(async () => ({ id: deviceId, active: false })),
      updateNotificationPreference: vi.fn(async () => ({
        channel: 'push', eventType: 'waitlist.offer.created', enabled: false,
      })),
    }
    const handler = createHttpHandler(service)
    const headers = { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' }

    const registerResponse = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: '/api/push/devices',
      body: { platform: 'web', token: 'fcm-token-value-long-enough' }, headers,
    }), registerResponse)
    expect(registerResponse.status).toBe(201)
    expect(service.registerPushDevice).toHaveBeenCalledWith('session-token', {
      platform: 'web', token: 'fcm-token-value-long-enough',
    })

    const preferenceResponse = makeResponse()
    await handler(makeRequest({
      method: 'PUT', url: `/api/organizations/${organization}/notification-preferences`,
      body: { eventType: 'waitlist.offer.created', enabled: false }, headers,
    }), preferenceResponse)
    expect(preferenceResponse.status).toBe(200)
    expect(service.updateNotificationPreference).toHaveBeenCalledWith(
      'session-token', organization, { eventType: 'waitlist.offer.created', enabled: false },
    )

    const revokeResponse = makeResponse()
    await handler(makeRequest({
      method: 'DELETE', url: `/api/push/devices/${deviceId}`, headers,
    }), revokeResponse)
    expect(revokeResponse.status).toBe(200)
    expect(service.revokePushDevice).toHaveBeenCalledWith('session-token', deviceId)
  })

  it('encaminha rotas de planos e contratos de clientes', async () => {
    const orgId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const clientId = 'aaaaaaaa-5000-4000-8000-000000000001'
    const contractId = 'aaaaaaaa-7200-4000-8000-000000000001'
    const service = {
      listPlans: vi.fn(async () => [{ id: 'plan-1', name: 'Plano Mensal' }]),
      createPlan: vi.fn(async () => ({ id: 'plan-1', name: 'Plano Mensal' })),
      listClientContracts: vi.fn(async () => [{ id: contractId, name: 'Plano Mensal' }]),
      createClientContract: vi.fn(async () => ({ id: contractId, name: 'Plano Mensal' })),
      updateClientContract: vi.fn(async () => ({ id: contractId, status: 'cancelled' })),
    }
    const handler = createHttpHandler(service)
    const headers = { cookie: 'clinicflow_session=session-token', origin: 'http://clinicflow.test' }

    const listPlansRes = makeResponse()
    await handler(makeRequest({ method: 'GET', url: `/api/organizations/${orgId}/plans`, headers }), listPlansRes)
    expect(listPlansRes.status).toBe(200)
    expect(service.listPlans).toHaveBeenCalledWith('session-token', orgId)

    const createPlanRes = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${orgId}/plans`,
      body: { name: 'Plano Mensal', priceCents: 25000 }, headers,
    }), createPlanRes)
    expect(createPlanRes.status).toBe(201)
    expect(service.createPlan).toHaveBeenCalledWith('session-token', orgId, { name: 'Plano Mensal', priceCents: 25000 })

    const listContractsRes = makeResponse()
    await handler(makeRequest({ method: 'GET', url: `/api/organizations/${orgId}/clients/${clientId}/contracts`, headers }), listContractsRes)
    expect(listContractsRes.status).toBe(200)
    expect(service.listClientContracts).toHaveBeenCalledWith('session-token', orgId, clientId)

    const createContractRes = makeResponse()
    await handler(makeRequest({
      method: 'POST', url: `/api/organizations/${orgId}/clients/${clientId}/contracts`,
      body: { planId: 'plan-1', startsOn: '2026-10-01' }, headers,
    }), createContractRes)
    expect(createContractRes.status).toBe(201)
    expect(service.createClientContract).toHaveBeenCalledWith('session-token', orgId, clientId, { planId: 'plan-1', startsOn: '2026-10-01' })

    const updateContractRes = makeResponse()
    await handler(makeRequest({
      method: 'PATCH', url: `/api/organizations/${orgId}/clients/${clientId}/contracts/${contractId}`,
      body: { status: 'cancelled' }, headers,
    }), updateContractRes)
    expect(updateContractRes.status).toBe(200)
    expect(service.updateClientContract).toHaveBeenCalledWith('session-token', orgId, clientId, contractId, { status: 'cancelled' })
  })

  it('encaminha consulta de convite e cadastro por convite com cookie de sessão', async () => {
    const service = {
      lookupInvitation: vi.fn(async (token) => ({
        valid: true,
        organizationName: 'Clínica Alfa',
        roleName: 'Profissional',
        roleCode: 'professional',
        email: 'convidado@example.com',
      })),
      register: vi.fn(async (body) => ({
        status: 'authenticated',
        token: 'new-session-token',
        session: { user: { id: 'user-1', email: 'convidado@example.com' } },
      })),
    }
    const handler = createHttpHandler(service, { secureCookies: false })

    const lookupRes = makeResponse()
    await handler(makeRequest({
      method: 'GET',
      url: '/api/auth/invitations/lookup?token=token-convite-xyz',
    }), lookupRes)
    expect(lookupRes.status).toBe(200)
    expect(lookupRes.payload).toMatchObject({ organizationName: 'Clínica Alfa', email: 'convidado@example.com' })
    expect(service.lookupInvitation).toHaveBeenCalledWith('token-convite-xyz')

    const registerRes = makeResponse()
    await handler(makeRequest({
      method: 'POST',
      url: '/api/auth/register',
      body: { inviteToken: 'token-convite-xyz', email: 'convidado@example.com', password: 'uma senha segura 123' },
    }), registerRes)
    expect(registerRes.status).toBe(201)
    expect(registerRes.headers['Set-Cookie']).toContain('clinicflow_session=new-session-token')
    expect(registerRes.payload.status).toBe('authenticated')
    expect(service.register).toHaveBeenCalledWith({
      inviteToken: 'token-convite-xyz',
      email: 'convidado@example.com',
      password: 'uma senha segura 123',
    })
  })
})
