import { respondPoll } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

// The poll that records the last signature also seals the request (a signed
// PDF and the evidence package into the archive).
export const maxDuration = 60

/**
 * POST /api/signera/:token/poll: where the signer's BankID stands, once a
 * second while it runs. The poll that sees it complete records the
 * signature. A budget of its own in the token limiter.
 */
export const POST = withSignerToken<{ token: string }>('signing.poll', { limiter: 'poll' }, respondPoll)
