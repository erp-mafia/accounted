import { respondStart } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

/**
 * POST /api/signing/me/:signerId/start: start a BankID signing for this signer
 * (a running one is cancelled first). Answers the QR and same-device tokens;
 * each start is a billable TIC session, so a short cooldown applies.
 */
export const POST = withMemberSigner<{ signerId: string }>('signing.member_start', {}, respondStart)
