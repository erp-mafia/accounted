import { respondCancel } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

/** POST /api/signing/me/:signerId/cancel: stop the BankID signing in progress; a new one can start. */
export const POST = withMemberSigner<{ signerId: string }>('signing.member_cancel_session', {}, respondCancel)
