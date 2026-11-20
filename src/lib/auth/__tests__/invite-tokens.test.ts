import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { generateInviteToken, hashInviteToken, getInviteExpiry } from '../invite-tokens'
import { INVITE_TTL_HOURS, INVITE_TTL_SECONDS } from '../invite-ttl'

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

  it('returns a Date exactly 24 hours in the future', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'))

    const expiry = getInviteExpiry()

    expect(expiry.toISOString()).toBe('2026-04-15T12:00:00.000Z')
  })

  it('takes the lifetime from INVITE_TTL_HOURS', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'))

    expect(getInviteExpiry().getTime() - Date.now()).toBe(INVITE_TTL_HOURS * 60 * 60 * 1000)
  })

  // Counted in elapsed time, not calendar days: the night the clocks go back
  // (Europe/Stockholm, 2026-10-25) must not stretch the lifetime by an hour.
  it('is the same length across a daylight saving change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))

    expect(getInviteExpiry().toISOString()).toBe('2026-10-25T12:00:00.000Z')
  })
})

describe('the invitation lifetime', () => {
  // CASA 1.1.2: an activation code expires after a short period. The tester
  // failed 7 days; lengthening this is a compliance decision, not a tweak.
  it('is 24 hours', () => {
    expect(INVITE_TTL_HOURS).toBe(24)
    expect(INVITE_TTL_SECONDS).toBe(24 * 60 * 60)
  })

  // A document cannot import the constant, so the one that states the
  // lifetime to self-hosters is read back here and fails when the two drift.
  it('is the lifetime the self-hosting guide states', () => {
    const guide = fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/SELF-HOSTING.md'),
      'utf8',
    )
    expect(guide).toContain(`valid for ${INVITE_TTL_HOURS} hours`)
  })
})
