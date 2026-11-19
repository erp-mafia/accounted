import { describe, expect, it } from 'vitest'
import {
  deriveVerificationState,
  FORM_OUT_STATES,
  NEEDS_LINK_STATES,
  RENEWAL_DUE_STATES,
  VERIFICATION_LINK_TTL_MS,
  VERIFICATION_RENEWAL_NOTICE_DAYS,
  VERIFICATION_STATES,
  verificationLinkExpiresAt,
  type VerificationRecordLike,
} from '../verification-state'

// A Tuesday midday in Stockholm (summer time): 2026-10-13 12:00 local.
const NOW = new Date('2026-10-13T10:00:00Z')
const HOUR = 60 * 60 * 1000

function record(overrides: Partial<VerificationRecordLike> = {}): VerificationRecordLike {
  return { status: 'unknown', valid_until: null, link_created_at: null, link_expires_at: null, handed_off_at: null, ...overrides }
}

function link(createdAt: Date, handedOff = false): Pick<VerificationRecordLike, 'link_created_at' | 'link_expires_at' | 'handed_off_at'> {
  return {
    link_created_at: createdAt.toISOString(),
    link_expires_at: verificationLinkExpiresAt(createdAt),
    handed_off_at: handedOff ? createdAt.toISOString() : null,
  }
}

describe('deriveVerificationState', () => {
  it('lists every state once and groups them for the readers', () => {
    expect(VERIFICATION_STATES).toEqual(['not_started', 'form_open', 'awaiting_signatory', 'link_expired', 'valid', 'expiring', 'expired'])
    expect([...FORM_OUT_STATES]).toEqual(['form_open', 'awaiting_signatory'])
    expect([...RENEWAL_DUE_STATES]).toEqual(['expiring', 'expired'])
    expect([...NEEDS_LINK_STATES]).toEqual(['not_started', 'link_expired', 'expiring', 'expired'])
  })

  it('is not_started with nothing on file, or with an unknown answer and no form', () => {
    expect(deriveVerificationState(null, NOW)).toEqual({
      state: 'not_started',
      status: 'unknown',
      valid_until: null,
      link_expires_at: null,
      days_left: null,
      renewal_form_open: false,
    })
    expect(deriveVerificationState(record(), NOW).state).toBe('not_started')
    expect(deriveVerificationState(record({ status: 'invalid' }), NOW).state).toBe('not_started')
  })

  it('is form_open while a link under 24 hours old exists, awaiting_signatory when that form was handed off', () => {
    const created = new Date(NOW.getTime() - HOUR)
    const open = deriveVerificationState(record({ status: 'invalid', ...link(created) }), NOW)
    expect(open.state).toBe('form_open')
    expect(open.link_expires_at).toBe(new Date(created.getTime() + VERIFICATION_LINK_TTL_MS).toISOString())
    expect(deriveVerificationState(record({ status: 'invalid', ...link(created, true) }), NOW).state).toBe('awaiting_signatory')
    // The provider has not answered at all yet: still the form's state.
    expect(deriveVerificationState(record({ status: 'unknown', ...link(created) }), NOW).state).toBe('form_open')
  })

  it('turns link_expired at exactly 24 hours, and stays open one second before', () => {
    const exactly = new Date(NOW.getTime() - VERIFICATION_LINK_TTL_MS)
    expect(deriveVerificationState(record({ status: 'invalid', ...link(exactly) }), NOW).state).toBe('link_expired')
    expect(deriveVerificationState(record({ status: 'invalid', ...link(exactly, true) }), NOW).state).toBe('link_expired')
    const almost = new Date(NOW.getTime() - VERIFICATION_LINK_TTL_MS + 1000)
    expect(deriveVerificationState(record({ status: 'invalid', ...link(almost) }), NOW).state).toBe('form_open')
    // A record from before link_expires_at was stored falls back to created + 24 h.
    const legacy = record({ status: 'invalid', link_created_at: exactly.toISOString(), link_expires_at: null })
    expect(deriveVerificationState(legacy, NOW).state).toBe('link_expired')
    expect(deriveVerificationState(legacy, NOW).link_expires_at).toBe(new Date(exactly.getTime() + VERIFICATION_LINK_TTL_MS).toISOString())
  })

  it('is valid far from the date, expiring at 30 days and inside, expired once the date has passed', () => {
    const far = deriveVerificationState(record({ status: 'valid', valid_until: '2027-10-03' }), NOW)
    expect(far).toMatchObject({ state: 'valid', status: 'valid', valid_until: '2027-10-03', days_left: 355 })
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-11-13' }), NOW).state).toBe('valid') // 31 days
    const edge = deriveVerificationState(record({ status: 'valid', valid_until: '2026-11-12' }), NOW) // 30 days
    expect(edge).toMatchObject({ state: 'expiring', days_left: VERIFICATION_RENEWAL_NOTICE_DAYS })
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-10-13' }), NOW)).toMatchObject({ state: 'expiring', days_left: 0 })
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-10-12' }), NOW)).toMatchObject({ state: 'expired', days_left: -1 })
    // Valid without a date: valid, nothing to count down.
    expect(deriveVerificationState(record({ status: 'valid' }), NOW)).toMatchObject({ state: 'valid', days_left: null })
  })

  it('counts the days on the Swedish calendar day, not the UTC one', () => {
    // 22:30Z on the 13th is already the 14th in Stockholm: 30 days to 2026-11-13, so expiring.
    const lateEvening = new Date('2026-10-13T22:30:00Z')
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-11-13' }), lateEvening)).toMatchObject({ state: 'expiring', days_left: 30 })
    // And a date that is "today" in Stockholm but tomorrow in UTC is not yet expired.
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-10-14' }), lateEvening)).toMatchObject({ state: 'expiring', days_left: 0 })
  })

  it('is expired when the provider says invalid after the company was once verified, and link_expired only for a renewal link made after the lapse', () => {
    const lapsed = record({ status: 'invalid', valid_until: '2026-09-30' })
    expect(deriveVerificationState(lapsed, NOW)).toMatchObject({ state: 'expired', days_left: -13 })
    // A link from the first verification, long dead: history, the state is expired.
    const oldLink = record({ ...lapsed, ...link(new Date('2025-09-29T09:00:00Z')) })
    expect(deriveVerificationState(oldLink, NOW).state).toBe('expired')
    // A renewal link created after the lapse that ran out: link_expired, so the page offers a new one.
    const renewalDead = record({ ...lapsed, ...link(new Date('2026-10-10T09:00:00Z')) })
    expect(deriveVerificationState(renewalDead, NOW).state).toBe('link_expired')
    // A live renewal link outranks the lapse.
    const renewalLive = record({ ...lapsed, ...link(new Date(NOW.getTime() - 2 * HOUR)) })
    expect(deriveVerificationState(renewalLive, NOW).state).toBe('form_open')
    expect(deriveVerificationState(record({ ...lapsed, ...link(new Date(NOW.getTime() - 2 * HOUR), true) }), NOW).state).toBe('awaiting_signatory')
    // Revoked while the date still lies ahead: expired, whatever dead link exists.
    const revoked = record({ status: 'invalid', valid_until: '2027-01-01', ...link(new Date('2026-10-01T09:00:00Z')) })
    expect(deriveVerificationState(revoked, NOW).state).toBe('expired')
  })

  it('keeps a still-valid verification valid or expiring while a renewal form is open, and says so', () => {
    const live = link(new Date(NOW.getTime() - HOUR))
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-11-01', ...live }), NOW)).toMatchObject({ state: 'expiring', renewal_form_open: true })
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2027-11-01', ...live }), NOW)).toMatchObject({ state: 'valid', renewal_form_open: true })
    const dead = link(new Date(NOW.getTime() - 2 * VERIFICATION_LINK_TTL_MS))
    expect(deriveVerificationState(record({ status: 'valid', valid_until: '2026-11-01', ...dead }), NOW)).toMatchObject({ state: 'expiring', renewal_form_open: false })
  })

  it('computes a link expiry 24 hours after creation', () => {
    expect(verificationLinkExpiresAt(new Date('2026-10-13T09:00:00Z'))).toBe('2026-10-14T09:00:00.000Z')
  })
})
