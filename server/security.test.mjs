// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createRecoveryCodes,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpCode,
  hashRecoveryCode,
  parseMfaEncryptionKey,
  verifyTotpCode,
} from './security.mjs'

const encryptionKey = parseMfaEncryptionKey('Y2xpbmljZmxvdy1sb2NhbC1tZmEta2V5LTMyLWJ5dGU')

describe('segurança MFA', () => {
  it('implementa o vetor TOTP SHA-1 do RFC 6238', () => {
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    expect(generateTotpCode(rfcSecret, 59_000, { digits: 8 })).toBe('94287082')
  })

  it('aceita somente a janela TOTP adjacente e retorna o passo para impedir replay', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const now = 1_800_000
    const previousCode = generateTotpCode(secret, now - 30_000)
    const distantCode = generateTotpCode(secret, now - 60_000)

    expect(verifyTotpCode(secret, previousCode, now)).toBe(59)
    expect(verifyTotpCode(secret, distantCode, now)).toBeNull()
    expect(verifyTotpCode(secret, '12345', now)).toBeNull()
  })

  it('protege o segredo TOTP com AES-GCM', () => {
    const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', encryptionKey)
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP')
    expect(decryptMfaSecret(encrypted, encryptionKey)).toBe('JBSWY3DPEHPK3PXP')
    const tampered = Buffer.from(encrypted, 'base64url')
    tampered[0] ^= 1
    expect(() => decryptMfaSecret(tampered.toString('base64url'), encryptionKey)).toThrow()
  })

  it('gera códigos de recuperação independentes e normaliza antes do hash', () => {
    const codes = createRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(codes.every((code) => /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/u.test(code))).toBe(true)
    expect(hashRecoveryCode(codes[0].toLowerCase())).toBe(hashRecoveryCode(codes[0]))
  })
})
