import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptHandoffValue, encryptHandoffValue } from '../lib/handoff-crypto'

describe('handoff encryption', () => {
  const context = JSON.stringify(['token', 'consent', 'user', 'https://brand.example', 'provider_code'])

  beforeEach(() => vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-server-secret'))
  afterEach(() => vi.unstubAllEnvs())

  it('encrypts identical values differently and preserves Unicode error text', () => {
    const plaintext = 'Återanrop: känsligt fel <script>'
    const first = encryptHandoffValue(plaintext, context)
    expect(first).not.toContain(plaintext)
    expect(first).not.toBe(encryptHandoffValue(plaintext, context))
    expect(decryptHandoffValue(first, context)).toBe(plaintext)
  })

  it('authenticates the ciphertext and rejects tampering', () => {
    const encrypted = encryptHandoffValue('provider-code', context)
    const bytes = Buffer.from(encrypted.slice(3), 'base64url')
    bytes[bytes.length - 1] ^= 1
    expect(() => decryptHandoffValue('v1:' + bytes.toString('base64url'), context)).toThrow()
  })

  it.each([0, 1, 2, 3, 4])('rejects swapping context component %s', (index) => {
    const encrypted = encryptHandoffValue('provider-code', context)
    const modified = JSON.parse(context) as string[]
    modified[index] += '-different'
    expect(() => decryptHandoffValue(encrypted, JSON.stringify(modified))).toThrow()
  })

  it('rejects plaintext and a different server secret', () => {
    expect(() => decryptHandoffValue('provider-code', context)).toThrow()
    const encrypted = encryptHandoffValue('provider-code', context)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'different-server-secret')
    expect(() => decryptHandoffValue(encrypted, context)).toThrow()
  })

  it('refuses to store credentials when the server secret is missing', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(() => encryptHandoffValue('provider-code', context)).toThrow('SUPABASE_SERVICE_ROLE_KEY is required')
  })
})
