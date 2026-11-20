import { respondDescribe } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

/**
 * GET /api/signing/me/:signerId: what the signer's page shows (the document's
 * title and fingerprint, who asks, the message, everyone asked to sign and
 * where each stands), for the logged-in member who is the signer. No
 * addresses, no personnummer.
 */
export const GET = withMemberSigner<{ signerId: string }>('signing.member_describe', {}, respondDescribe)
