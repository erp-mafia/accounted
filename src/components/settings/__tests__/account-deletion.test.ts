import { describe, expect, it } from 'vitest'
import { canDeleteAccount } from '@/components/settings/account-deletion'

// The deletion gate on the most destructive settings surface. The server
// enforces the same precondition with a 409, but the button must never claim
// an unblocked path the client has not confirmed: "cannot read the blockers"
// means "cannot permit deletion", never "no blockers".
describe('canDeleteAccount', () => {
  it('permits deletion only after a confirmed empty blocker list', () => {
    expect(canDeleteAccount([])).toBe(true)
  })

  it('blocks while the user still owns companies', () => {
    expect(canDeleteAccount([{ id: 'c1', name: 'Testbolaget AB' }])).toBe(false)
  })

  it('never permits deletion while the blocker list is unknown (loading or failed read)', () => {
    // The original bug: a failed GET /api/company left blockers = [] with
    // loading = false, so exactly this case rendered an unblocked
    // "Radera konto" button to a user who still owns companies.
    expect(canDeleteAccount(null)).toBe(false)
  })
})
