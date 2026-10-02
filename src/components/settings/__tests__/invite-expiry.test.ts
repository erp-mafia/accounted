import { describe, expect, it } from 'vitest'
import { isInviteExpired } from '@/components/settings/invite-expiry'

// crm#241: a pending invitation past its expiry kept rendering "Går ut
// <date>" because the roster never compared the date with now. Status stays
// 'pending' in the database until someone tries the dead link, so the
// roster's only signal is expires_at.
describe('isInviteExpired', () => {
  const now = new Date('2026-09-30T12:00:00Z')

  it('is false while the expiry is in the future', () => {
    expect(isInviteExpired('2026-10-07T12:00:00Z', now)).toBe(false)
  })

  it('is true once the expiry has passed', () => {
    expect(isInviteExpired('2026-09-22T09:15:00Z', now)).toBe(true)
  })

  it('is true at the exact expiry instant', () => {
    expect(isInviteExpired('2026-09-30T12:00:00Z', now)).toBe(true)
  })

  it('does not call an unparseable timestamp expired', () => {
    expect(isInviteExpired('not-a-date', now)).toBe(false)
  })

  it('defaults to the current time', () => {
    expect(isInviteExpired('2000-01-01T00:00:00Z')).toBe(true)
    expect(isInviteExpired('2999-01-01T00:00:00Z')).toBe(false)
  })
})
