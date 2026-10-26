import { respondDecline } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

/** POST /api/signing/me/:signerId/decline: the signer declines, with an optional reason; the request closes. */
export const POST = withMemberSigner<{ signerId: string }>('signing.member_decline', {}, respondDecline)
