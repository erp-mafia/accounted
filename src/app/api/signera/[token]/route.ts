import { respondDescribe } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/**
 * GET /api/signera/:token: what the signer's page shows (the document's
 * title and fingerprint, who asks, the message, everyone asked to sign and
 * where each stands). The link is the authentication; no addresses, no
 * personnummer.
 */
export const GET = withSignerToken<{ token: string }>('signing.describe', {}, respondDescribe)
