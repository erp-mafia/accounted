import { describe, it, expect } from 'vitest'

process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

import { decryptCredential, encryptCredential, isZettleConfigured } from '../lib/credentials'

describe('zettle credentials', () => {
  it('round-trips AES-GCM ciphertext', () => {
    const cipher = encryptCredential('IZSEC-refresh-token')
    expect(cipher).not.toContain('IZSEC')
    expect(decryptCredential(cipher)).toBe('IZSEC-refresh-token')
  })

  it('is configured only when all three env vars are set', () => {
    const prev = {
      id: process.env.ZETTLE_CLIENT_ID,
      secret: process.env.ZETTLE_CLIENT_SECRET,
      key: process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY,
    }
    process.env.ZETTLE_CLIENT_ID = 'id'
    process.env.ZETTLE_CLIENT_SECRET = 'secret'
    process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY = 'key'
    expect(isZettleConfigured()).toBe(true)
    delete process.env.ZETTLE_CLIENT_ID
    expect(isZettleConfigured()).toBe(false)
    process.env.ZETTLE_CLIENT_ID = prev.id
    process.env.ZETTLE_CLIENT_SECRET = prev.secret
    process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY = prev.key
  })
})
