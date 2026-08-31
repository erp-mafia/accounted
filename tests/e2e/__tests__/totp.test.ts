/**
 * RFC 6238 conformance for the suite's TOTP generator.
 *
 * The E2E suite keeps MFA switched on and computes codes the way an
 * authenticator app would, so this generator sits directly in the path of
 * every browser test that signs in. A silent off-by-one here would look like
 * "MFA is broken" rather than "the test helper is wrong", which is worth the
 * five assertions it takes to rule out.
 */
import { describe, it, expect } from 'vitest'
import { totp, base32Decode, nextDistinctTotp } from '../../../spectest/lib/totp'

// RFC 6238 Appendix B, SHA-1 rows. The published secret is the ASCII string
// "12345678901234567890"; base32 of those 20 bytes is the value below.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('totp', () => {
  it('decodes base32 back to the RFC secret', () => {
    expect(base32Decode(RFC_SECRET).toString('utf8')).toBe('12345678901234567890')
  })

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(totp(RFC_SECRET, { atMs: seconds * 1000, digits: 8 })).toBe(expected)
  })

  it('produces six digits by default', () => {
    expect(totp(RFC_SECRET)).toMatch(/^\d{6}$/)
  })

  it('rejects a character outside the base32 alphabet', () => {
    expect(() => totp('ABC!')).toThrow(/invalid base32/)
  })

  it('steps forward when the previous code is still current', () => {
    const now = totp(RFC_SECRET)
    // Supabase refuses a replayed code inside the same 30s step, so the helper
    // has to hand back a different one rather than the same string.
    expect(nextDistinctTotp(RFC_SECRET, now)).not.toBe(now)
    expect(nextDistinctTotp(RFC_SECRET, '000000')).toBe(now)
  })
})
