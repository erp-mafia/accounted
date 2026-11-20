import { describe, expect, it } from 'vitest'
import { MIGRATION_PROVIDERS, missingTokenCredential, tokenCredentials } from '../catalog'

const BL_KEY = '1f0e2d3c-4b5a-4968-8776-655443322110'

describe('token provider credentials', () => {
  it('connects Björn Lundén with the company key alone: there is no API key to ask for', () => {
    // The books act's form demanded an "API-nyckel från Björn Lundén" and kept
    // Anslut disabled without one; BL never issues such a key.
    expect(tokenCredentials('bjornlunden')).toEqual({ secret: false, companyId: true })
    expect(missingTokenCredential('bjornlunden', { apiToken: '', companyId: BL_KEY })).toBeNull()
    expect(missingTokenCredential('bjornlunden', { apiToken: '', companyId: '' })).toBe('companyId')
  })

  it('asks Bokio, Briox and WINT for both the secret and the company', () => {
    for (const provider of ['bokio', 'briox', 'wint']) {
      expect(missingTokenCredential(provider, { apiToken: 'secret', companyId: 'company' })).toBeNull()
      expect(missingTokenCredential(provider, { apiToken: '', companyId: 'company' })).toBe('secret')
      expect(missingTokenCredential(provider, { apiToken: 'secret', companyId: null })).toBe('companyId')
    }
  })

  it('keeps the old token-only answer for providers without credentials (the OAuth ones)', () => {
    expect(tokenCredentials('fortnox')).toEqual({ secret: true, companyId: false })
    expect(missingTokenCredential('visma', { apiToken: undefined })).toBe('secret')
    expect(missingTokenCredential('unknown', { apiToken: 'secret' })).toBeNull()
  })

  it('names the credentials of every token provider, so a new one cannot fall back silently', () => {
    for (const provider of MIGRATION_PROVIDERS) {
      expect(provider.credentials !== undefined, provider.id).toBe(provider.authType === 'token')
    }
  })
})
