/**
 * Two ciphertext formats: `v2.` sealed with MAIL_TOKEN_ENCRYPTION_KEY, and
 * the unprefixed legacy format sealed with the key derived from the service
 * role key. Production holds legacy rows, so setting the dedicated key must
 * never strand them, and a `v2.` token must never be read any other way.
 */
import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MailTokenKeyError,
  createOAuthFlow,
  createOAuthState,
  decryptToken,
  encryptToken,
  pkceS256Challenge,
  shouldReseal,
  verifyOAuthState,
} from '../crypto'

const SERVICE_ROLE = 'service-role-secret'
const KEY_A = 'ab'.repeat(32)
const KEY_B = 'cd'.repeat(32)

/** A legacy ciphertext exactly as the code before the dedicated key wrote it. */
function legacySeal(plaintext: string): string {
  const key = crypto.createHash('sha256').update('mail-connections:v1:' + SERVICE_ROLE).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE)
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('without MAIL_TOKEN_ENCRYPTION_KEY: exactly the legacy behaviour', () => {
  it('seals unprefixed with the derived key and reads it back', () => {
    const sealed = encryptToken('refresh-1')
    expect(sealed.startsWith('v2.')).toBe(false)
    expect(decryptToken(sealed)).toBe('refresh-1')
  })

  it('reads a row written by the code before the dedicated key existed', () => {
    expect(decryptToken(legacySeal('refresh-prod'))).toBe('refresh-prod')
  })
})

describe('with MAIL_TOKEN_ENCRYPTION_KEY', () => {
  beforeEach(() => vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_A))

  it('seals new tokens as v2 and reads them back', () => {
    const sealed = encryptToken('refresh-2')
    expect(sealed.startsWith('v2.')).toBe(true)
    expect(decryptToken(sealed)).toBe('refresh-2')
  })

  it('still reads a legacy row with the derived key', () => {
    expect(decryptToken(legacySeal('refresh-prod'))).toBe('refresh-prod')
  })

  it('tolerates the whitespace a pasted key picks up', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', `${KEY_A}\n`)
    expect(decryptToken(encryptToken('refresh-3'))).toBe('refresh-3')
  })

  it('says a legacy row should be re-sealed, and a v2 row should not', () => {
    expect(shouldReseal(legacySeal('x'))).toBe(true)
    expect(shouldReseal(encryptToken('x'))).toBe(false)
  })

  it('keeps OAuth states working under the dedicated key', () => {
    const state = createOAuthState('user-1', 'company-1', 'verifier')
    expect(state.startsWith('v2.')).toBe(true)
    expect(verifyOAuthState(state)).toEqual({ userId: 'user-1', companyId: 'company-1', codeVerifier: 'verifier' })
  })
})

describe('fail closed', () => {
  it('never reads a v2 token with the derived key when the dedicated key is gone', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_A)
    const sealed = encryptToken('refresh-4')
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '')

    expect(() => decryptToken(sealed)).toThrow(MailTokenKeyError)
  })

  it('refuses a v2 token under a different key', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_A)
    const sealed = encryptToken('refresh-5')
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_B)

    expect(() => decryptToken(sealed)).toThrow()
  })

  it('refuses a legacy token given a v2 prefix: the dedicated key cannot open it', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_A)
    expect(() => decryptToken(`v2.${legacySeal('refresh-6')}`)).toThrow()
  })

  it('refuses a malformed key instead of sealing with a truncated one', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', 'not-hex')
    expect(() => encryptToken('refresh-7')).toThrow(MailTokenKeyError)
    // A legacy row still reads: it never needed the dedicated key.
    expect(decryptToken(legacySeal('refresh-prod'))).toBe('refresh-prod')
    expect(shouldReseal(legacySeal('x'))).toBe(false)
  })

  it('treats a state sealed before a key change as expired rather than trusting it', () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_A)
    const state = createOAuthState('user-1', 'company-1')
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', KEY_B)
    expect(verifyOAuthState(state)).toBeNull()
  })
})

describe('PKCE (RFC 7636)', () => {
  it('matches the S256 example of RFC 7636 appendix B', () => {
    expect(pkceS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('seals a fresh 43-character verifier in the state and sends only its challenge', () => {
    const first = createOAuthFlow('user-1', 'company-1')
    const second = createOAuthFlow('user-1', 'company-1')

    const verified = verifyOAuthState(first.state)
    expect(verified).toMatchObject({ userId: 'user-1', companyId: 'company-1' })
    expect(verified?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.codeChallenge).not.toBe(second.codeChallenge)
  })
})
