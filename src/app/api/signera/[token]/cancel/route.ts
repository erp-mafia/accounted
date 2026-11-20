import { respondCancel } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/** POST /api/signera/:token/cancel: stop the BankID signing in progress; a new one can start. */
export const POST = withSignerToken<{ token: string }>('signing.cancel_session', {}, respondCancel)
