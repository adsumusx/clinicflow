import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthService } from './auth-service.mjs'
import { createHttpHandler } from './http-app.mjs'
import { PostgresAuthRepository } from './postgres-auth-repository.mjs'
import {
  FcmPushProvider,
  parsePushEncryptionKey,
  PushOutboxWorker,
  PushTokenCipher,
} from './push-service.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória para iniciar a API.')

const repository = new PostgresAuthRepository(databaseUrl)
const resetBaseUrl = process.env.PASSWORD_RESET_BASE_URL ?? `http://localhost:${port}/#reset-password`
const pushEncryptionKey = parsePushEncryptionKey(
  process.env.PUSH_TOKEN_ENCRYPTION_KEY ?? process.env.MFA_ENCRYPTION_KEY,
)

async function notifyPasswordReset({ email, token }) {
  if (!process.env.PASSWORD_RESET_WEBHOOK_URL) {
    console.warn('password_reset_notifier_unconfigured')
    return
  }
  const response = await fetch(process.env.PASSWORD_RESET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, resetUrl: `${resetBaseUrl}?token=${encodeURIComponent(token)}` }),
  })
  if (!response.ok) throw new Error('password reset notification failed')
}

const api = createHttpHandler(new AuthService(repository, {
  notifyPasswordReset,
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
  pushTokenEncryptionKey: pushEncryptionKey,
}))

const fcmConfiguration = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY,
}
const configuredFcmValues = Object.values(fcmConfiguration).filter(Boolean).length
if (configuredFcmValues > 0 && configuredFcmValues < 3) {
  throw new Error('Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY em conjunto.')
}
const pushWorker = configuredFcmValues === 3
  ? new PushOutboxWorker(
      repository,
      new FcmPushProvider(fcmConfiguration),
      new PushTokenCipher(pushEncryptionKey),
    )
  : null
let pushWorkerRunning = false
async function pollPushOutbox() {
  if (!pushWorker || pushWorkerRunning) return
  pushWorkerRunning = true
  try {
    await pushWorker.runOnce()
  } catch (error) {
    console.error('push_worker_error', { code: error?.code ?? 'UNEXPECTED' })
  } finally {
    pushWorkerRunning = false
  }
}
const pushWorkerTimer = pushWorker
  ? setInterval(pollPushOutbox, Number(process.env.PUSH_WORKER_INTERVAL_MS ?? 5_000))
  : null
pushWorkerTimer?.unref()
void pollPushOutbox()
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (request, response) => {
  if (request.url?.startsWith('/api/')) return api(request, response)

  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const candidate = normalize(join(root, 'dist', pathname === '/' ? 'index.html' : pathname))
  const distRoot = normalize(join(root, 'dist'))
  const file = candidate.startsWith(distRoot) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(distRoot, 'index.html')
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  })
  createReadStream(file).pipe(response)
})

server.listen(port, host, () => console.log(`ClinicFlow disponível em http://localhost:${port} (rede: http://${host}:${port})`))

async function shutdown() {
  if (pushWorkerTimer) clearInterval(pushWorkerTimer)
  server.close()
  await repository.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
