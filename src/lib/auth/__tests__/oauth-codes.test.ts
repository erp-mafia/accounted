import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { createAuthCode, decryptAuthCode, verifyPkce, hashAuthCode } from '../oauth-codes'

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-secret-for-oauth-tests')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// ============================================================
// createAuthCode + decryptAuthCode round-trip
// ============================================================

describe('createAuthCode + decryptAuthCode round-trip', () => {
  it('encrypts and decrypts preserving userId, codeChallenge, redirectUri', () => {
    const payload = {
      userId: 'user-123',
      codeChallenge: 'challenge-abc',
      redirectUri: 'https://claude.ai/api/callback',
    }

    const code = createAuthCode(payload)
    const decrypted = decryptAuthCode(code)

    expect(decrypted).not.toBeNull()
    expect(decrypted!.userId).toBe('user-123')
    expect(decrypted!.codeChallenge).toBe('challenge-abc')
    expect(decrypted!.redirectUri).toBe('https://claude.ai/api/callback')
  })

  it('sets exp approximately 5 minutes in future', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'))

    const code = createAuthCode({
      userId: 'user-1',
      codeChallenge: 'ch',
      redirectUri: 'http://localhost',
    })
    const decrypted = decryptAuthCode(code)

    expect(decrypted).not.toBeNull()
    // exp should be Date.now() + 5 * 60 * 1000
    const expectedExp = new Date('2026-04-14T12:00:00Z').getTime() + 5 * 60 * 1000
    expect(decrypted!.exp).toBe(expectedExp)
  })

  it('returns null for expired code', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'))

    const code = createAuthCode({
      userId: 'user-1',
      codeChallenge: 'ch',
      redirectUri: 'http://localhost',
    })

    // Advance past 5 minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    const decrypted = decryptAuthCode(code)
    expect(decrypted).toBeNull()
  })

  it('returns null for tampered ciphertext', () => {
    const code = createAuthCode({
      userId: 'user-1',
      codeChallenge: 'ch',
      redirectUri: 'http://localhost',
    })

    // Flip a character in the middle of the encrypted string
    const chars = code.split('')
    const mid = Math.floor(chars.length / 2)
    chars[mid] = chars[mid] === 'A' ? 'B' : 'A'
    const tampered = chars.join('')

    expect(decryptAuthCode(tampered)).toBeNull()
  })

  it('returns null for completely invalid base64url', () => {
    expect(decryptAuthCode('not-a-valid-code!!!')).toBeNull()
  })

  it('throws when SUPABASE_SERVICE_ROLE_KEY is not set', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')

    expect(() =>
      createAuthCode({
        userId: 'user-1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost',
      })
    ).toThrow('SUPABASE_SERVICE_ROLE_KEY is required')
  })
})

// ============================================================
// verifyPkce
// ============================================================

describe('verifyPkce', () => {
  it('returns true when SHA256(verifier) matches challenge', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    // Compute expected challenge using base64url(SHA-256(verifier))
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

    expect(verifyPkce(verifier, challenge)).toBe(true)
  })

  it('returns false when verifier does not match challenge', () => {
    expect(verifyPkce('correct-verifier', 'wrong-challenge')).toBe(false)
  })
})

// ============================================================
// hashAuthCode
// ============================================================

describe('hashAuthCode', () => {
  it('returns 64-char hex string', () => {
    const hash = hashAuthCode('some-auth-code')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    const hash1 = hashAuthCode('deterministic-code')
    const hash2 = hashAuthCode('deterministic-code')
    expect(hash1).toBe(hash2)
  })
})

describe('verifyPkce with a missing challenge', () => {
  it('never verifies when the code was minted without a code_challenge', () => {
    // /authorize does not reject a missing code_challenge; it mints the code
    // with an empty one. That must stay unexchangeable, otherwise a
    // custom-scheme (cursor://) hijacker could skip PKCE entirely.
    expect(verifyPkce('any-verifier', '')).toBe(false)
    expect(verifyPkce('', '')).toBe(false)
  })
})
