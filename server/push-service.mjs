import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'

const fcmScope = 'https://www.googleapis.com/auth/firebase.messaging'
const oauthAudience = 'https://oauth2.googleapis.com/token'
const safeTemplates = Object.freeze({
  'waitlist.offer.created': Object.freeze({
    key: 'waitlist_offer_available',
    title: 'Uma vaga ficou disponível',
    body: 'Abra o ClinicFlow para consultar e responder à oferta.',
    data: Object.freeze({ type: 'waitlist_offer', route: '/area-do-cliente' }),
  }),
  'billing.reminder': Object.freeze({
    key: 'billing_reminder_pending',
    title: 'Lembrete financeiro',
    body: 'Abra o ClinicFlow para consultar uma cobrança pendente.',
    data: Object.freeze({ type: 'billing_reminder', route: '/area-do-cliente#my-invoices' }),
  }),
})

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function parsePushEncryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey ?? ''), 'base64url')
  if (key.length !== 32) {
    throw new Error('PUSH_TOKEN_ENCRYPTION_KEY deve conter exatamente 32 bytes em base64url.')
  }
  return key
}

export class PushTokenCipher {
  constructor(key) {
    this.key = Buffer.from(key)
    if (this.key.length !== 32) throw new Error('A chave de push deve conter exatamente 32 bytes.')
  }

  fingerprint(token) {
    return createHash('sha256').update(token).digest('hex')
  }

  encrypt(token) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }

  decrypt(encrypted) {
    const [ivValue, tagValue, ciphertextValue] = String(encrypted ?? '').split('.')
    if (!ivValue || !tagValue || !ciphertextValue) throw new Error('invalid encrypted push token')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }
}

export class PushProviderError extends Error {
  constructor(code, { retryable = true, invalidToken = false } = {}) {
    super(`push provider error: ${code}`)
    this.name = 'PushProviderError'
    this.code = code
    this.retryable = retryable
    this.invalidToken = invalidToken
  }
}

export class FcmPushProvider {
  constructor({ projectId, clientEmail, privateKey, fetchImpl = fetch }) {
    if (!projectId || !clientEmail || !privateKey) throw new Error('Credenciais do FCM incompletas.')
    this.projectId = projectId
    this.clientEmail = clientEmail
    this.privateKey = String(privateKey).replace(/\\n/gu, '\n')
    createPrivateKey(this.privateKey)
    this.fetch = fetchImpl
    this.accessToken = null
  }

  async #getAccessToken() {
    const now = Math.floor(Date.now() / 1000)
    if (this.accessToken?.expiresAt > now + 60) return this.accessToken.value
    const header = encodeJson({ alg: 'RS256', typ: 'JWT' })
    const claims = encodeJson({
      iss: this.clientEmail, sub: this.clientEmail, aud: oauthAudience,
      scope: fcmScope, iat: now, exp: now + 3600,
    })
    const unsigned = `${header}.${claims}`
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.privateKey).toString('base64url')}`
    const response = await this.fetch(oauthAudience, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
      }),
    })
    if (!response.ok) throw new PushProviderError('FCM_AUTH_ERROR')
    const body = await response.json()
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new PushProviderError('FCM_AUTH_ERROR')
    }
    this.accessToken = { value: body.access_token, expiresAt: now + Number(body.expires_in ?? 3600) }
    return this.accessToken.value
  }

  async send({ token, template }) {
    const accessToken = await this.#getAccessToken()
    let response
    try {
      response = await this.fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            token,
            notification: { title: template.title, body: template.body },
            data: template.data,
            android: { priority: 'high' },
            webpush: { headers: { Urgency: 'high' } },
          } }),
        },
      )
    } catch {
      throw new PushProviderError('FCM_NETWORK_ERROR')
    }
    const body = await response.json().catch(() => ({}))
    if (response.ok) return { messageId: body.name ?? null }
    const providerCode = body?.error?.details?.find?.((detail) => detail.errorCode)?.errorCode
      ?? body?.error?.status ?? `HTTP_${response.status}`
    const invalidToken = ['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'].includes(providerCode)
    const retryable = !invalidToken && (response.status === 429 || response.status >= 500)
    throw new PushProviderError(providerCode, { retryable, invalidToken })
  }
}

export class PushOutboxWorker {
  constructor(repository, provider, tokenCipher, options = {}) {
    this.repository = repository
    this.provider = provider
    this.tokenCipher = tokenCipher
    this.workerId = options.workerId ?? randomUUID()
    this.batchSize = options.batchSize ?? 20
    this.maxAttempts = options.maxAttempts ?? 5
  }

  async runOnce() {
    const events = await this.repository.claimPushOutboxEvents({
      workerId: this.workerId, limit: this.batchSize,
    })
    for (const event of events) await this.#deliverEvent(event)
    return events.length
  }

  async #deliverEvent(event) {
    const template = safeTemplates[event.eventType]
    if (!template) {
      await this.repository.finishPushOutboxEvent({ eventId: event.id, workerId: this.workerId })
      return
    }
    try {
      const deliveries = await this.repository.preparePushDeliveries({ event, templateKey: template.key })
      let retryableFailure = false
      for (const delivery of deliveries) {
        try {
          const token = this.tokenCipher.decrypt(delivery.tokenCiphertext)
          const result = await this.provider.send({ token, template })
          await this.repository.markPushDeliverySent({
            event, deliveryId: delivery.id, messageId: result.messageId,
          })
        } catch (error) {
          const invalidToken = error instanceof PushProviderError && error.invalidToken
          const retryable = !(error instanceof PushProviderError) || error.retryable
          const exhausted = event.attemptCount >= this.maxAttempts
          await this.repository.markPushDeliveryFailed({
            event,
            deliveryId: delivery.id,
            deviceId: delivery.deviceId,
            errorCode: error?.code ?? 'PUSH_DELIVERY_ERROR',
            retryable: retryable && !exhausted,
            revokeDevice: invalidToken,
          })
          retryableFailure ||= retryable && !exhausted
        }
      }
      if (retryableFailure) {
        await this.repository.retryPushOutboxEvent({
          eventId: event.id, workerId: this.workerId, attemptCount: event.attemptCount,
          errorCode: 'PUSH_DELIVERY_RETRY',
        })
      } else {
        await this.repository.finishPushOutboxEvent({ eventId: event.id, workerId: this.workerId })
      }
    } catch (error) {
      if (event.attemptCount >= this.maxAttempts) {
        await this.repository.failPushOutboxEvent({
          eventId: event.id, workerId: this.workerId, errorCode: error?.code ?? 'PUSH_PROCESSING_ERROR',
        })
      } else {
        await this.repository.retryPushOutboxEvent({
          eventId: event.id, workerId: this.workerId, attemptCount: event.attemptCount,
          errorCode: error?.code ?? 'PUSH_PROCESSING_ERROR',
        })
      }
    }
  }
}

export { safeTemplates }
