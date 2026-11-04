import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCallback,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const scryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const derivedKeyLength = 64
const dummyPasswordHash = await hashPassword('ClinicFlow dummy password only')

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function validateEmail(value) {
  const email = normalizeEmail(value)
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function validatePassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, derivedKeyLength, scryptOptions)
  return `scrypt$${scryptOptions.N}$${scryptOptions.r}$${scryptOptions.p}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`
}

export async function verifyPassword(password, encodedHash) {
  try {
    const [algorithm, n, r, p, saltValue, keyValue] = encodedHash.split('$')
    if (algorithm !== 'scrypt') return false
    const expected = Buffer.from(keyValue, 'base64url')
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export async function verifyPasswordWithoutEnumeration(password, encodedHash) {
  return verifyPassword(password, encodedHash ?? dummyPasswordHash)
}

export function createOpaqueToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const totpPeriodSeconds = 30

export function encodeBase32(value) {
  const bytes = Buffer.from(value)
  let bits = 0
  let accumulator = 0
  let encoded = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      encoded += base32Alphabet[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) encoded += base32Alphabet[(accumulator << (5 - bits)) & 31]
  return encoded
}

export function decodeBase32(value) {
  const normalized = String(value ?? '').toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '')
  let bits = 0
  let accumulator = 0
  const decoded = []
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character)
    if (index < 0) throw new Error('invalid base32 value')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      decoded.push((accumulator >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(decoded)
}

export function createTotpSecret() {
  return encodeBase32(randomBytes(20))
}

export function generateTotpCode(secret, timestampMs = Date.now(), options = {}) {
  const digits = options.digits ?? 6
  const periodSeconds = options.periodSeconds ?? totpPeriodSeconds
  const step = Math.floor(timestampMs / 1000 / periodSeconds)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 15
  const binary = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255)
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

export function verifyTotpCode(secret, code, timestampMs = Date.now()) {
  const submitted = typeof code === 'string' ? code.trim() : ''
  if (!/^\d{6}$/u.test(submitted)) return null
  const currentStep = Math.floor(timestampMs / 1000 / totpPeriodSeconds)
  for (const offset of [0, -1, 1]) {
    const step = currentStep + offset
    const expected = generateTotpCode(secret, step * totpPeriodSeconds * 1000)
    const expectedBuffer = Buffer.from(expected)
    const submittedBuffer = Buffer.from(submitted)
    if (expectedBuffer.length === submittedBuffer.length && timingSafeEqual(expectedBuffer, submittedBuffer)) {
      return step
    }
  }
  return null
}

export function parseMfaEncryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey ?? ''), 'base64url')
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY deve conter exatamente 32 bytes em base64url.')
  return key
}

export function encryptMfaSecret(secret, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptMfaSecret(encrypted, key) {
  const [ivValue, tagValue, ciphertextValue] = String(encrypted ?? '').split('.')
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('invalid encrypted MFA secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const encoded = encodeBase32(randomBytes(10))
    return encoded.match(/.{1,4}/gu).join('-')
  })
}

export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z2-7]/gu, '')
}

export function hashRecoveryCode(code) {
  return hashToken(normalizeRecoveryCode(code))
}

export function createTotpUri({ secret, email, issuer = 'ClinicFlow' }) {
  const label = `${issuer}:${email}`
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}
