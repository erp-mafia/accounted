import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateInviteToken, hashInviteToken, getInviteExpiry } from '../invite-tokens'

describe('generateInviteToken', () => {
  it('returns token starting with "gnubok_inv_"', () => {
    const { token } = generateInviteToken()
    expect(token.startsWith('gnubok_inv_')).toBe(true)
  })

  it('returns a 64-char hex SHA-256 hash', () => {
    const { hash } = generateInviteToken()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hash matches hashInviteToken(token)', () => {
    const { token, hash } = generateInviteToken()
    expect(hashInviteToken(token)).toBe(hash)
  })

  it('generates unique tokens on successive calls', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('hashInviteToken', () => {
  it('returns 64-char hex string', () => {
    const hash = hashInviteToken('gnubok_inv_test-token')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    const hash1 = hashInviteToken('gnubok_inv_deterministic')
    const hash2 = hashInviteToken('gnubok_inv_deterministic')
    expect(hash1).toBe(hash2)
  })
})

describe('getInviteExpiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a Date exactly 7 days in the future', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'))

    const expiry = getInviteExpiry()

    expect(expiry.toISOString()).toBe('2026-04-21T12:00:00.000Z')
  })
})
