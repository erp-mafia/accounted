import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'crypto'
import { computeIdentityHash } from '../identity-hash'

const USER = '3f7c1d2e-0000-4000-8000-abcdefabcdef'

describe('computeIdentityHash', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('returns null when the secret is unset (dev / CI / self-hosted)', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', '')
    expect(computeIdentityHash(USER)).toBeNull()
  })

  it('returns null for an empty distinct id rather than hashing nothing', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_secret')
    expect(computeIdentityHash('')).toBeNull()
  })

  it('matches HMAC-SHA256(distinctId, secret) in hex, as PostHog expects', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_secret')
    const expected = crypto.createHmac('sha256', 'phs_secret').update(USER).digest('hex')
    expect(computeIdentityHash(USER)).toBe(expected)
    expect(computeIdentityHash(USER)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is stable across calls for the same user', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_secret')
    expect(computeIdentityHash(USER)).toBe(computeIdentityHash(USER))
  })

  it('differs per user', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_secret')
    expect(computeIdentityHash(USER)).not.toBe(computeIdentityHash(USER.replace('3f7c', '4a8d')))
  })

  it('changes when the key is rotated, invalidating old hashes', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_old')
    const before = computeIdentityHash(USER)
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_new')
    expect(computeIdentityHash(USER)).not.toBe(before)
  })

  // The hash crosses to the browser; the key must not be derivable from it.
  it('never echoes the secret into its output', () => {
    vi.stubEnv('POSTHOG_SECRET_API_KEY', 'phs_supersecretvalue')
    expect(computeIdentityHash(USER)).not.toContain('supersecretvalue')
  })
})
