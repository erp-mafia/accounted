import { respondStart } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/**
 * POST /api/signera/:token/start: start a BankID signing for this signer
 * (a running one is cancelled first). Answers the QR and same-device tokens;
 * each start is a billable TIC session, so a short cooldown applies.
 */
export const POST = withSignerToken<{ token: string }>('signing.start', {}, respondStart)
