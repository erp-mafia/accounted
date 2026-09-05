import { describe, it, expect, vi, afterEach } from 'vitest'
import { isMfaExemptionActive, isMfaRequired, shouldEnforceMfa } from '../mfa'

describe('mfa helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isMfaRequired', () => {
    it('returns false when self-hosted', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(false)
    })

    it('returns true when hosted and MFA required', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })
  })

  describe('shouldEnforceMfa', () => {
    it('returns false when MFA is not required', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(false)
    })

    it('returns false when user has bankid_linked', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_linked: true } })).toBe(false)
    })

    it('returns false for a pending BankID signup (person proven, mailbox not)', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_pending: true, has_password: false } })).toBe(false)
      // Only the literal flag counts: a stale or falsy value enforces.
      expect(shouldEnforceMfa({ app_metadata: { bankid_pending: null } })).toBe(true)
    })

    it('returns true when MFA required and no bankid', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(true)
    })

    it('skips MFA while a service-role exemption is still in the future', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt_until: future } })).toBe(false)
    })

    it('enforces MFA again once the exemption has expired', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      const past = new Date(Date.now() - 60 * 1000).toISOString()
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt_until: past } })).toBe(true)
    })

    it('treats a malformed or non-string exemption as no exemption', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt_until: 'soon' } })).toBe(true)
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt_until: true } })).toBe(true)
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt_until: 4102444800000 } })).toBe(true)
      expect(shouldEnforceMfa({ app_metadata: { mfa_exempt: true } })).toBe(true)
    })

    it('returns true when app_metadata is undefined', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({})).toBe(true)
    })
  })

  describe('isMfaExemptionActive', () => {
    it('compares against the clock it is given', () => {
      const user = { app_metadata: { mfa_exempt_until: '2026-10-01T00:00:00Z' } }
      expect(isMfaExemptionActive(user, new Date('2026-09-30T23:59:59Z'))).toBe(true)
      expect(isMfaExemptionActive(user, new Date('2026-10-01T00:00:00Z'))).toBe(false)
    })
  })
})
