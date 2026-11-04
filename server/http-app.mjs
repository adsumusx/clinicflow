import { ServiceError } from './auth-service.mjs'

const cookieName = 'clinicflow_session'
const maximumBodyBytes = 16 * 1024

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function csv(response, body, filename) {
  response.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function getCookie(request, name) {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=')
    if (separator < 0) continue
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim())
    }
  }
  return null
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new ServiceError(415, 'JSON_REQUIRED', 'Envie os dados em JSON.')
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBodyBytes) throw new ServiceError(413, 'BODY_TOO_LARGE', 'Requisição muito grande.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new ServiceError(400, 'INVALID_JSON', 'JSON inválido.')
  }
}

class RateLimiter {
  constructor(limit = 12, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.buckets = new Map()
  }

  check(key) {
    const now = Date.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    bucket.count += 1
    if (bucket.count > this.limit) {
      throw new ServiceError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde um pouco e tente novamente.')
    }
  }
}

function sessionCookie(token, secure) {
  const attributes = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=28800',
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

function clearedSessionCookie(secure) {
  const attributes = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

function authenticationResponse(response, status, result, secureCookies) {
  if (result.status === 'mfa_required') return json(response, status, result)
  const body = {
    status: 'authenticated',
    session: result.session,
    ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
  }
  return json(response, status, body, { 'Set-Cookie': sessionCookie(result.token, secureCookies) })
}

function headerValue(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return undefined
  const first = raw.split(',')[0]?.trim()
  return first || undefined
}

function requireSameOrigin(request) {
  const site = headerValue(request.headers['sec-fetch-site'])
  if (site === 'cross-site') {
    throw new ServiceError(403, 'ORIGIN_FORBIDDEN', 'Origem da solicitação não permitida.')
  }
  // O navegador impede falsificar Sec-Fetch-Site. No dev, o proxy troca o Host
  // pela porta da API e a comparação direta com Origin rejeitaria o próprio app.
  if (site === 'same-origin') return
  const origin = headerValue(request.headers.origin)
  if (!origin) return
  const protocol = headerValue(request.headers['x-forwarded-proto'])
    ?? (request.socket.encrypted ? 'https' : 'http')
  const hosts = [
    headerValue(request.headers['x-forwarded-host']),
    headerValue(request.headers.host),
  ].filter(Boolean)
  let allowed = false
  try {
    const actual = new URL(origin).origin
    allowed = hosts.some((host) => actual === `${protocol}://${host}`)
  } catch {
    allowed = false
  }
  if (!allowed) {
    throw new ServiceError(403, 'ORIGIN_FORBIDDEN', 'Origem da solicitação não permitida.')
  }
}

export function createHttpHandler(authService, options = {}) {
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production'
  const limiter = options.rateLimiter ?? new RateLimiter()

  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const token = getCookie(request, cookieName)
    const requestKey = `${request.socket.remoteAddress ?? 'local'}:${url.pathname}`

    try {
      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        return json(response, 200, await authService.getSession(token))
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/invitations/lookup') {
        limiter.check(requestKey)
        const tokenParam = url.searchParams.get('token')
        return json(response, 200, await authService.lookupInvitation(tokenParam))
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        limiter.check(requestKey)
        const result = await authService.register(await readJson(request))
        return authenticationResponse(response, 201, result, secureCookies)
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        limiter.check(requestKey)
        const result = await authService.login(await readJson(request))
        return authenticationResponse(response, 200, result, secureCookies)
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/mfa/verify') {
        limiter.check(requestKey)
        const result = await authService.verifyMfa(await readJson(request))
        return authenticationResponse(response, 200, result, secureCookies)
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/password/forgot') {
        limiter.check(requestKey)
        return json(response, 202, await authService.requestPasswordReset(await readJson(request)))
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/password/reset') {
        limiter.check(requestKey)
        return json(response, 200, await authService.resetPassword(await readJson(request)))
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        await authService.logout(token)
        return json(response, 204, undefined, { 'Set-Cookie': clearedSessionCookie(secureCookies) })
      }

      if (request.method === 'GET' && url.pathname === '/api/push/devices') {
        return json(response, 200, { devices: await authService.listPushDevices(token) })
      }
      if (request.method === 'POST' && url.pathname === '/api/push/devices') {
        requireSameOrigin(request)
        return json(response, 201, await authService.registerPushDevice(token, await readJson(request)))
      }
      const pushDeviceRoute = url.pathname.match(/^\/api\/push\/devices\/([0-9a-f-]+)$/i)
      if (pushDeviceRoute && request.method === 'DELETE') {
        requireSameOrigin(request)
        return json(response, 200, await authService.revokePushDevice(token, pushDeviceRoute[1]))
      }

      if (request.method === 'POST' && url.pathname === '/api/organizations') {
        return json(response, 201, await authService.createOrganization(token, await readJson(request)))
      }

      if (request.method === 'POST' && url.pathname === '/api/organizations/select') {
        const body = await readJson(request)
        return json(response, 200, await authService.selectOrganization(token, body.organizationId))
      }

      const notificationPreferencesRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/notification-preferences$/i,
      )
      if (notificationPreferencesRoute && request.method === 'GET') {
        return json(response, 200, await authService.listNotificationPreferences(
          token, notificationPreferencesRoute[1],
        ))
      }
      if (notificationPreferencesRoute && request.method === 'PUT') {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateNotificationPreference(
          token, notificationPreferencesRoute[1], await readJson(request),
        ))
      }

      const auditRoute = url.pathname.match(/^\/api\/organizations\/([0-9a-f-]+)\/audit-events$/i)
      if (auditRoute && request.method === 'GET') {
        return json(response, 200, await authService.listAuditEvents(token, auditRoute[1], {
          limit: url.searchParams.get('limit') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          targetType: url.searchParams.get('targetType') ?? undefined,
          targetId: url.searchParams.get('targetId') ?? undefined,
        }))
      }

      const receivableRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/receivables(?:\/([0-9a-f-]+))?$/i,
      )
      const receivablePaymentRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/receivables\/([0-9a-f-]+)\/payments(?:\/([0-9a-f-]+)\/reversal)?$/i,
      )
      const contractBillingRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/receivables\/generate$/i,
      )
      if (contractBillingRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.generateContractReceivables(
          token, contractBillingRoute[1], await readJson(request),
        ))
      }
      if (receivablePaymentRoute && request.method === 'POST' && !receivablePaymentRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createReceivablePayment(
          token, receivablePaymentRoute[1], receivablePaymentRoute[2], await readJson(request),
        ))
      }
      if (receivablePaymentRoute && request.method === 'POST' && receivablePaymentRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.reverseReceivablePayment(
          token, receivablePaymentRoute[1], receivablePaymentRoute[2],
          receivablePaymentRoute[3], await readJson(request),
        ))
      }
      if (receivableRoute && request.method === 'GET' && !receivableRoute[2]) {
        return json(response, 200, await authService.listReceivables(token, receivableRoute[1], {
          status: url.searchParams.get('status') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          dueFrom: url.searchParams.get('dueFrom') ?? undefined,
          dueTo: url.searchParams.get('dueTo') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }))
      }
      if (receivableRoute && request.method === 'GET' && receivableRoute[2]) {
        return json(response, 200, await authService.getReceivable(
          token, receivableRoute[1], receivableRoute[2],
        ))
      }
      if (receivableRoute && request.method === 'POST' && !receivableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createReceivable(
          token, receivableRoute[1], await readJson(request),
        ))
      }
      if (receivableRoute && request.method === 'PUT' && receivableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateReceivable(
          token, receivableRoute[1], receivableRoute[2], await readJson(request),
        ))
      }
      if (receivableRoute && request.method === 'DELETE' && receivableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.cancelReceivable(
          token, receivableRoute[1], receivableRoute[2], await readJson(request),
        ))
      }

      const financialCategoryRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/financial-categories$/i,
      )
      if (financialCategoryRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createFinancialCategory(
          token, financialCategoryRoute[1], await readJson(request),
        ))
      }

      const plansRoute = url.pathname.match(/^\/api\/organizations\/([0-9a-f-]+)\/plans$/i)
      if (plansRoute && request.method === 'GET') {
        return json(response, 200, await authService.listPlans(token, plansRoute[1]))
      }
      if (plansRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createPlan(
          token, plansRoute[1], await readJson(request),
        ))
      }

      const payableRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/payables(?:\/([0-9a-f-]+))?$/i,
      )
      const payablePaymentRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/payables\/([0-9a-f-]+)\/payments(?:\/([0-9a-f-]+)\/reversal)?$/i,
      )
      if (payablePaymentRoute && request.method === 'POST' && !payablePaymentRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createPayablePayment(
          token, payablePaymentRoute[1], payablePaymentRoute[2], await readJson(request),
        ))
      }
      if (payablePaymentRoute && request.method === 'POST' && payablePaymentRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.reversePayablePayment(
          token, payablePaymentRoute[1], payablePaymentRoute[2],
          payablePaymentRoute[3], await readJson(request),
        ))
      }
      if (payableRoute && request.method === 'GET' && !payableRoute[2]) {
        return json(response, 200, await authService.listPayables(token, payableRoute[1], {
          status: url.searchParams.get('status') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          dueFrom: url.searchParams.get('dueFrom') ?? undefined,
          dueTo: url.searchParams.get('dueTo') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }))
      }
      if (payableRoute && request.method === 'GET' && payableRoute[2]) {
        return json(response, 200, await authService.getPayable(token, payableRoute[1], payableRoute[2]))
      }
      if (payableRoute && request.method === 'POST' && !payableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createPayable(
          token, payableRoute[1], await readJson(request),
        ))
      }
      if (payableRoute && request.method === 'PUT' && payableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updatePayable(
          token, payableRoute[1], payableRoute[2], await readJson(request),
        ))
      }
      if (payableRoute && request.method === 'DELETE' && payableRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.cancelPayable(
          token, payableRoute[1], payableRoute[2], await readJson(request),
        ))
      }

      const reportFiltersRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/filters$/i,
      )
      if (reportFiltersRoute && request.method === 'GET') {
        return json(response, 200, await authService.getReportFilters(token, reportFiltersRoute[1]))
      }

      const birthdayReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/birthdays(?:\/(export))?$/i,
      )
      if (birthdayReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }
        if (birthdayReportRoute[2]) {
          const exported = await authService.exportBirthdayReport(
            token, birthdayReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.listBirthdayReport(
          token, birthdayReportRoute[1], input,
        ))
      }

      const clientReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/clients(?:\/(export))?$/i,
      )
      if (clientReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          clientType: url.searchParams.get('clientType') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }
        if (clientReportRoute[2]) {
          const exported = await authService.exportClientReport(
            token, clientReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.listClientReport(
          token, clientReportRoute[1], input,
        ))
      }

      const clientActivityReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/client-activity(?:\/(export))?$/i,
      )
      if (clientActivityReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          granularity: url.searchParams.get('granularity') ?? undefined,
          bucket: url.searchParams.get('bucket') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }
        if (clientActivityReportRoute[2]) {
          const exported = await authService.exportClientActivityReport(
            token, clientActivityReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.listClientActivityReport(
          token, clientActivityReportRoute[1], input,
        ))
      }

      const businessDashboardReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/dashboard(?:\/(export))?$/i,
      )
      if (businessDashboardReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        }
        if (businessDashboardReportRoute[2]) {
          const exported = await authService.exportBusinessDashboardReport(
            token, businessDashboardReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.getBusinessDashboardReport(
          token, businessDashboardReportRoute[1], input,
        ))
      }

      const equipmentUsageReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/equipment-usage(?:\/(export))?$/i,
      )
      if (equipmentUsageReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          modalityId: url.searchParams.get('modalityId') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }
        if (equipmentUsageReportRoute[2]) {
          const exported = await authService.exportEquipmentUsageReport(
            token, equipmentUsageReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.listEquipmentUsageReport(
          token, equipmentUsageReportRoute[1], input,
        ))
      }

      const prospectReportRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/reports\/prospects(?:\/(export))?$/i,
      )
      if (prospectReportRoute && request.method === 'GET') {
        const input = {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }
        if (prospectReportRoute[2]) {
          const exported = await authService.exportProspectReport(
            token, prospectReportRoute[1], input,
          )
          return csv(response, exported.content, exported.filename)
        }
        return json(response, 200, await authService.listProspectReport(
          token, prospectReportRoute[1], input,
        ))
      }

      const clientProfileRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/clients\/([0-9a-f-]+)\/profile$/i,
      )
      if (clientProfileRoute && request.method === 'GET') {
        return json(response, 200, await authService.getClientProfile(
          token, clientProfileRoute[1], clientProfileRoute[2],
        ))
      }

      const clientClinicalRecordsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/clients\/([0-9a-f-]+)\/clinical-records$/i,
      )
      if (clientClinicalRecordsRoute && request.method === 'GET') {
        return json(response, 200, await authService.listClientClinicalRecords(
          token, clientClinicalRecordsRoute[1], clientClinicalRecordsRoute[2],
        ))
      }
      if (clientClinicalRecordsRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createClientClinicalRecord(
          token, clientClinicalRecordsRoute[1], clientClinicalRecordsRoute[2], await readJson(request),
        ))
      }

      const clientContractsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/clients\/([0-9a-f-]+)\/contracts(?:\/([0-9a-f-]+))?$/i,
      )
      if (clientContractsRoute && !clientContractsRoute[3] && request.method === 'GET') {
        return json(response, 200, await authService.listClientContracts(
          token, clientContractsRoute[1], clientContractsRoute[2],
        ))
      }
      if (clientContractsRoute && !clientContractsRoute[3] && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createClientContract(
          token, clientContractsRoute[1], clientContractsRoute[2], await readJson(request),
        ))
      }
      if (clientContractsRoute && clientContractsRoute[3] && (request.method === 'PATCH' || request.method === 'PUT')) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateClientContract(
          token, clientContractsRoute[1], clientContractsRoute[2], clientContractsRoute[3], await readJson(request),
        ))
      }

      const clientCheckInRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/appointments\/([0-9a-f-]+)\/check-in$/i,
      )
      if (clientCheckInRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 200, await authService.selfCheckIn(
          token, clientCheckInRoute[1], clientCheckInRoute[2],
        ))
      }

      const ownClinicalContentRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/clinical-content$/i,
      )
      if (ownClinicalContentRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnPublishedClinicalContent(
          token, ownClinicalContentRoute[1],
        ))
      }

      const ownContactChannelsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/contact$/i,
      )
      if (ownContactChannelsRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnContactChannels(
          token, ownContactChannelsRoute[1],
        ))
      }

      const ownInvoicesRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/invoices$/i,
      )
      if (ownInvoicesRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnInvoices(token, ownInvoicesRoute[1]))
      }

      const clientInterestRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/appointments\/([0-9a-f-]+)\/interest$/i,
      )
      if (clientInterestRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.joinOwnWaitlist(
          token, clientInterestRoute[1], clientInterestRoute[2],
        ))
      }
      if (clientInterestRoute && request.method === 'DELETE') {
        requireSameOrigin(request)
        return json(response, 200, await authService.leaveOwnWaitlist(
          token, clientInterestRoute[1], clientInterestRoute[2],
        ))
      }

      const clientWaitlistConfirmationRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/appointments\/([0-9a-f-]+)\/waitlist\/confirm$/i,
      )
      if (clientWaitlistConfirmationRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 200, await authService.confirmOwnWaitlistOffer(
          token, clientWaitlistConfirmationRoute[1], clientWaitlistConfirmationRoute[2],
        ))
      }

      const clientReplacementBookingRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/appointments\/([0-9a-f-]+)\/replacement$/i,
      )
      if (clientReplacementBookingRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.bookOwnAppointmentWithReplacement(
          token, clientReplacementBookingRoute[1], clientReplacementBookingRoute[2],
        ))
      }

      const ownReplacementCreditsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/replacement-credits$/i,
      )
      if (ownReplacementCreditsRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnReplacementCredits(
          token, ownReplacementCreditsRoute[1],
        ))
      }

      const clientWaitlistRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/waitlist$/i,
      )
      if (clientWaitlistRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnWaitlist(token, clientWaitlistRoute[1]))
      }

      const clientAppointmentsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area\/appointments$/i,
      )
      if (clientAppointmentsRoute && request.method === 'GET') {
        return json(response, 200, await authService.getOwnAppointments(token, clientAppointmentsRoute[1]))
      }

      const clientAreaRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/client-area$/i,
      )
      if (clientAreaRoute && request.method === 'GET') {
        return json(response, 200, await authService.getClientArea(token, clientAreaRoute[1]))
      }

      const replacementCreditsRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/clients\/([0-9a-f-]+)\/replacement-credits(?:\/([0-9a-f-]+))?$/i,
      )
      if (replacementCreditsRoute && request.method === 'GET' && !replacementCreditsRoute[3]) {
        return json(response, 200, await authService.listReplacementCredits(
          token, replacementCreditsRoute[1], replacementCreditsRoute[2],
        ))
      }
      if (replacementCreditsRoute && request.method === 'POST' && !replacementCreditsRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.issueReplacementCredit(
          token, replacementCreditsRoute[1], replacementCreditsRoute[2], await readJson(request),
        ))
      }
      if (replacementCreditsRoute && request.method === 'DELETE' && replacementCreditsRoute[3]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.cancelReplacementCredit(
          token, replacementCreditsRoute[1], replacementCreditsRoute[2], replacementCreditsRoute[3],
        ))
      }

      const clientRoute = url.pathname.match(/^\/api\/organizations\/([0-9a-f-]+)\/clients(?:\/([0-9a-f-]+))?$/i)
      if (clientRoute && request.method === 'GET' && !clientRoute[2]) {
        return json(response, 200, await authService.listClients(token, clientRoute[1], {
          clientType: url.searchParams.get('type') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }))
      }
      if (clientRoute && request.method === 'GET' && clientRoute[2]) {
        return json(response, 200, await authService.getClient(token, clientRoute[1], clientRoute[2]))
      }
      if (clientRoute && request.method === 'POST' && !clientRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createClient(
          token, clientRoute[1], await readJson(request),
        ))
      }
      if (clientRoute && request.method === 'PUT' && clientRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateClient(
          token, clientRoute[1], clientRoute[2], await readJson(request),
        ))
      }
      if (clientRoute && request.method === 'DELETE' && clientRoute[2]) {
        requireSameOrigin(request)
        await authService.archiveClient(token, clientRoute[1], clientRoute[2])
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        return response.end()
      }

      const prospectInteractionRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/prospects\/([0-9a-f-]+)\/interactions$/i,
      )
      if (prospectInteractionRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.addProspectInteraction(
          token, prospectInteractionRoute[1], prospectInteractionRoute[2], await readJson(request),
        ))
      }

      const prospectConversionRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/prospects\/([0-9a-f-]+)\/convert$/i,
      )
      if (prospectConversionRoute && request.method === 'POST') {
        requireSameOrigin(request)
        const result = await authService.convertProspect(
          token, prospectConversionRoute[1], prospectConversionRoute[2], await readJson(request),
        )
        return json(response, result.created ? 201 : 200, result)
      }

      const prospectRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/prospects(?:\/([0-9a-f-]+))?$/i,
      )
      if (prospectRoute && request.method === 'GET' && !prospectRoute[2]) {
        return json(response, 200, await authService.listProspects(token, prospectRoute[1], {
          stage: url.searchParams.get('stage') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          page: url.searchParams.get('page') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
        }))
      }
      if (prospectRoute && request.method === 'GET' && prospectRoute[2]) {
        return json(response, 200, await authService.getProspect(
          token, prospectRoute[1], prospectRoute[2],
        ))
      }
      if (prospectRoute && request.method === 'POST' && !prospectRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createProspect(
          token, prospectRoute[1], await readJson(request),
        ))
      }
      if (prospectRoute && request.method === 'PUT' && prospectRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateProspect(
          token, prospectRoute[1], prospectRoute[2], await readJson(request),
        ))
      }

      const resourceRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/resources(?:\/(modalities|services|rooms|equipment)(?:\/([0-9a-f-]+))?)?$/i,
      )
      if (resourceRoute && request.method === 'GET' && !resourceRoute[2]) {
        return json(response, 200, await authService.listResources(token, resourceRoute[1], {
          status: url.searchParams.get('status') ?? undefined,
        }))
      }
      if (resourceRoute && request.method === 'POST' && resourceRoute[2] && !resourceRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createResource(
          token, resourceRoute[1], resourceRoute[2].toLowerCase(), await readJson(request),
        ))
      }
      if (resourceRoute && request.method === 'PUT' && resourceRoute[2] && resourceRoute[3]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateResource(
          token, resourceRoute[1], resourceRoute[2].toLowerCase(), resourceRoute[3], await readJson(request),
        ))
      }

      const availabilityRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/availability-rules(?:\/([0-9a-f-]+))?$/i,
      )
      if (availabilityRoute && request.method === 'GET' && !availabilityRoute[2]) {
        return json(response, 200, await authService.listAvailability(token, availabilityRoute[1], {
          professionalId: url.searchParams.get('professionalId') ?? undefined,
        }))
      }
      if (availabilityRoute && request.method === 'POST' && !availabilityRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createAvailability(
          token, availabilityRoute[1], await readJson(request),
        ))
      }
      if (availabilityRoute && request.method === 'PUT' && availabilityRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateAvailability(
          token, availabilityRoute[1], availabilityRoute[2], await readJson(request),
        ))
      }

      const classRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments\/classes$/i,
      )
      if (classRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createClassAppointment(
          token, classRoute[1], await readJson(request),
        ))
      }

      const participantRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments\/([0-9a-f-]+)\/participants(?:\/([0-9a-f-]+))?$/i,
      )
      if (participantRoute && request.method === 'POST' && !participantRoute[3]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.addAppointmentParticipant(
          token, participantRoute[1], participantRoute[2], await readJson(request),
        ))
      }

      const waitlistAdvanceRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments\/([0-9a-f-]+)\/waitlist\/advance$/i,
      )
      if (waitlistAdvanceRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 200, await authService.advanceWaitlistOffer(
          token, waitlistAdvanceRoute[1], waitlistAdvanceRoute[2],
        ))
      }
      if (participantRoute && request.method === 'DELETE' && participantRoute[3]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.cancelAppointmentParticipant(
          token, participantRoute[1], participantRoute[2], participantRoute[3],
        ))
      }

      const participantStatusRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments\/([0-9a-f-]+)\/participants\/([0-9a-f-]+)\/status$/i,
      )
      if (participantStatusRoute && request.method === 'PATCH') {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateAppointmentParticipantStatus(
          token, participantStatusRoute[1], participantStatusRoute[2], participantStatusRoute[3],
          await readJson(request),
        ))
      }

      const seriesRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointment-series$/i,
      )
      if (seriesRoute && request.method === 'POST') {
        requireSameOrigin(request)
        return json(response, 201, await authService.createAppointmentSeries(
          token, seriesRoute[1], await readJson(request),
        ))
      }

      const occurrenceRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments\/([0-9a-f-]+)\/occurrences$/i,
      )
      if (occurrenceRoute && request.method === 'PUT') {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateAppointmentOccurrences(
          token, occurrenceRoute[1], occurrenceRoute[2], await readJson(request),
        ))
      }

      const appointmentRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/appointments(?:\/([0-9a-f-]+))?$/i,
      )
      if (appointmentRoute && request.method === 'GET' && !appointmentRoute[2]) {
        return json(response, 200, await authService.getSchedule(token, appointmentRoute[1], {
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          professionalId: url.searchParams.get('professionalId') ?? undefined,
        }))
      }
      if (appointmentRoute && request.method === 'POST' && !appointmentRoute[2]) {
        requireSameOrigin(request)
        return json(response, 201, await authService.createAppointment(
          token, appointmentRoute[1], await readJson(request),
        ))
      }
      if (appointmentRoute && request.method === 'PUT' && appointmentRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateAppointment(
          token, appointmentRoute[1], appointmentRoute[2], await readJson(request),
        ))
      }
      if (appointmentRoute && request.method === 'DELETE' && appointmentRoute[2]) {
        requireSameOrigin(request)
        return json(response, 200, await authService.cancelAppointment(
          token, appointmentRoute[1], appointmentRoute[2],
        ))
      }

      const professionalRoute = url.pathname.match(
        /^\/api\/organizations\/([0-9a-f-]+)\/professionals\/([0-9a-f-]+)$/i,
      )
      if (professionalRoute && (request.method === 'PATCH' || request.method === 'PUT')) {
        requireSameOrigin(request)
        return json(response, 200, await authService.updateProfessional(
          token, professionalRoute[1], professionalRoute[2], await readJson(request),
        ))
      }

      const membershipRoute = url.pathname.match(/^\/api\/organizations\/([0-9a-f-]+)\/memberships(?:\/([0-9a-f-]+))?$/i)
      if (membershipRoute && request.method === 'GET' && !membershipRoute[2]) {
        return json(response, 200, await authService.listMemberships(token, membershipRoute[1]))
      }
      if (membershipRoute && request.method === 'POST' && !membershipRoute[2]) {
        return json(response, 201, await authService.inviteMember(token, membershipRoute[1], await readJson(request)))
      }
      if (membershipRoute && request.method === 'DELETE' && membershipRoute[2]) {
        await authService.revokeMembership(token, membershipRoute[1], membershipRoute[2])
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        return response.end()
      }

      return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } })
    } catch (error) {
      if (error instanceof ServiceError) {
        return json(response, error.status, { error: { code: error.code, message: error.message } })
      }
      console.error('api_request_failed', { path: url.pathname, error: error?.message ?? error, stack: error?.stack })
      return json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a solicitação.' } })
    }
  }
}
