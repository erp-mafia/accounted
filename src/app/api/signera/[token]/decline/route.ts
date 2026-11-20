import { respondDecline } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/** POST /api/signera/:token/decline: the signer declines, with an optional reason; the request closes. */
export const POST = withSignerToken<{ token: string }>('signing.decline', {}, respondDecline)
