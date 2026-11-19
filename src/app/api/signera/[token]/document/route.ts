import { respondDocument } from '@/lib/signing/ceremony-routes'
import { withSignerToken } from '@/lib/signing/route'

/** GET /api/signera/:token/document: the PDF being signed, inline; ?copy=signed the signed copy once everyone has signed. Only the request's own documents. */
export const GET = withSignerToken<{ token: string }>('signing.document', {}, respondDocument)
