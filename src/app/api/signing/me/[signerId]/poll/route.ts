import { respondPoll } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

// The poll that records the last signature also seals the request (a signed
// PDF and the evidence package into the archive).
export const maxDuration = 60

/**
 * POST /api/signing/me/:signerId/poll: where the signer's BankID stands, once a
 * second while it runs. The poll that sees it complete records the
 * signature. A budget of its own in the signer limiter.
 */
export const POST = withMemberSigner<{ signerId: string }>('signing.member_poll', { limiter: 'poll' }, respondPoll)
