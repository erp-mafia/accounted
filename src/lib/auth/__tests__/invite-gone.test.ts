import { describe, it, expect } from 'vitest'
import { INVITE_GONE_REASONS, inviteGoneReason } from '../invite-gone'

describe('inviteGoneReason', () => {
  it('reads each known reason off a 410 body', () => {
    for (const reason of INVITE_GONE_REASONS) {
      expect(inviteGoneReason({ error: 'x', reason })).toBe(reason)
    }
  })

  it('answers null for a body without a reason, an unknown reason, or no body', () => {
    expect(inviteGoneReason({ error: 'Inbjudan hittades inte eller är ogiltig.' })).toBeNull()
    expect(inviteGoneReason({ reason: 'something_else' })).toBeNull()
    expect(inviteGoneReason(null)).toBeNull()
    expect(inviteGoneReason('410')).toBeNull()
  })
})
