// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  PushOutboxWorker,
  PushProviderError,
  PushTokenCipher,
  safeTemplates,
} from './push-service.mjs'

const encryptionKey = Buffer.alloc(32, 7)

function event(attemptCount = 1) {
  return {
    id: 'event-a', organizationId: 'org-a', aggregateId: 'offer-a',
    eventType: 'waitlist.offer.created', attemptCount, recipientUserId: 'user-a',
  }
}

function repository(overrides = {}) {
  const cipher = new PushTokenCipher(encryptionKey)
  return {
    claimPushOutboxEvents: vi.fn(async () => [event()]),
    preparePushDeliveries: vi.fn(async () => [{
      id: 'delivery-a', deviceId: 'device-a', tokenCiphertext: cipher.encrypt('fcm-device-token-that-is-valid'),
    }]),
    markPushDeliverySent: vi.fn(async () => {}),
    markPushDeliveryFailed: vi.fn(async () => {}),
    finishPushOutboxEvent: vi.fn(async () => {}),
    retryPushOutboxEvent: vi.fn(async () => {}),
    failPushOutboxEvent: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('push seguro e Outbox', () => {
  it('cifra tokens com nonce e mantém somente uma impressão estável para deduplicação', () => {
    const cipher = new PushTokenCipher(encryptionKey)
    const token = 'fcm-device-token-that-must-not-leak'
    const first = cipher.encrypt(token)
    const second = cipher.encrypt(token)

    expect(first).not.toContain(token)
    expect(first).not.toBe(second)
    expect(cipher.decrypt(first)).toBe(token)
    expect(cipher.fingerprint(token)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('entrega o template fixo sem incorporar o payload de domínio', async () => {
    const repo = repository()
    const provider = { send: vi.fn(async () => ({ messageId: 'projects/p/messages/1' })) }
    const worker = new PushOutboxWorker(repo, provider, new PushTokenCipher(encryptionKey))

    expect(await worker.runOnce()).toBe(1)
    expect(provider.send).toHaveBeenCalledWith({
      token: 'fcm-device-token-that-is-valid',
      template: safeTemplates['waitlist.offer.created'],
    })
    expect(provider.send.mock.calls[0][0].template.data).toEqual({
      type: 'waitlist_offer', route: '/area-do-cliente',
    })
    expect(JSON.stringify(provider.send.mock.calls[0][0].template)).not.toMatch(
      /appointmentId|offerId|fullName|startsAt|serviceName|patientName/iu,
    )
    expect(repo.markPushDeliverySent).toHaveBeenCalledOnce()
    expect(repo.finishPushOutboxEvent).toHaveBeenCalledWith({ eventId: 'event-a', workerId: expect.any(String) })
  })

  it('agenda retentativa transitória sem concluir o evento', async () => {
    const repo = repository()
    const provider = {
      send: vi.fn(async () => { throw new PushProviderError('UNAVAILABLE') }),
    }
    const worker = new PushOutboxWorker(repo, provider, new PushTokenCipher(encryptionKey))

    await worker.runOnce()

    expect(repo.markPushDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      retryable: true, revokeDevice: false,
    }))
    expect(repo.retryPushOutboxEvent).toHaveBeenCalledOnce()
    expect(repo.finishPushOutboxEvent).not.toHaveBeenCalled()
  })

  it('revoga token rejeitado pelo FCM e termina o evento sem repetição infinita', async () => {
    const repo = repository()
    const provider = {
      send: vi.fn(async () => {
        throw new PushProviderError('UNREGISTERED', { retryable: false, invalidToken: true })
      }),
    }
    const worker = new PushOutboxWorker(repo, provider, new PushTokenCipher(encryptionKey))

    await worker.runOnce()

    expect(repo.markPushDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      retryable: false, revokeDevice: true, errorCode: 'UNREGISTERED',
    }))
    expect(repo.finishPushOutboxEvent).toHaveBeenCalledOnce()
    expect(repo.retryPushOutboxEvent).not.toHaveBeenCalled()
  })
})
