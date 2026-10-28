import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url, isWebauthnMfaEnabled, toWebauthnJson } from '../webauthn-mfa'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isWebauthnMfaEnabled (crm#1448)', () => {
  it('is off unless the flag is exactly true, and always off on self-hosted', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', '')
    expect(isWebauthnMfaEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', '1')
    expect(isWebauthnMfaEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', 'true')
    expect(isWebauthnMfaEnabled()).toBe(true)
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(isWebauthnMfaEnabled()).toBe(false)
  })
})

describe('base64url codec', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes))
  })
})

describe('toWebauthnJson', () => {
  it('re-encodes every binary field and leaves plain values alone', () => {
    const json = toWebauthnJson({
      challenge: new Uint8Array([1, 2, 3]).buffer,
      user: { id: new Uint8Array([255]), name: 'n', displayName: 'd' },
      excludeCredentials: [{ id: new Uint8Array([4]).buffer, type: 'public-key', transports: ['usb'] }],
      timeout: 60000,
      rp: { id: 'app.accounted.se', name: 'Accounted' },
    })
    expect(json).toEqual({
      challenge: 'AQID',
      user: { id: '_w', name: 'n', displayName: 'd' },
      excludeCredentials: [{ id: 'BA', type: 'public-key', transports: ['usb'] }],
      timeout: 60000,
      rp: { id: 'app.accounted.se', name: 'Accounted' },
    })
  })
})
