import { describe, it, expect, beforeEach } from 'vitest'
import {
  encryptToken,
  decryptToken,
  createOAuthState,
  verifyOAuthState,
} from '../crypto'

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-that-is-long-enough'
})

describe('token encryption', () => {
  it('round-trips a refresh token', () => {
    const token = '1//0abcdef_refresh_token_value'
    const encrypted = encryptToken(token)
    expect(encrypted).not.toContain(token)
    expect(decryptToken(encrypted)).toBe(token)
  })

  it('produces different ciphertext for the same plaintext (IV is random)', () => {
    const token = 'same-token'
    const a = encryptToken(token)
    const b = encryptToken(token)
    expect(a).not.toBe(b)
    expect(decryptToken(a)).toBe(token)
    expect(decryptToken(b)).toBe(token)
  })

  it('fails to decrypt tampered ciphertext', () => {
    const encrypted = encryptToken('secret')
    // Flip a byte in the middle of the ciphertext.
    const buf = Buffer.from(encrypted, 'base64url')
    buf[30] ^= 0xff
    const tampered = buf.toString('base64url')
    expect(() => decryptToken(tampered)).toThrow()
  })
})

describe('OAuth state', () => {
  it('round-trips userId and companyId', () => {
    const state = createOAuthState('user-1', 'company-1')
    expect(verifyOAuthState(state)).toEqual({
      userId: 'user-1',
      companyId: 'company-1',
    })
  })

  it('returns null for garbage state', () => {
    expect(verifyOAuthState('not-a-valid-state')).toBeNull()
  })

  it('returns null for expired state', () => {
    const state = createOAuthState('user-1', 'company-1')
    // Fast-forward past the 10-minute TTL.
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60 * 1000
    try {
      expect(verifyOAuthState(state)).toBeNull()
    } finally {
      Date.now = realNow
    }
  })
})
