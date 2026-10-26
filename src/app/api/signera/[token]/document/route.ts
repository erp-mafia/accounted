import { respondDocument } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/** GET /api/signera/:token/document: the PDF being signed, inline. Only the request's own document. */
export const GET = withSignerToken<{ token: string }>('signing.document', {}, respondDocument)
