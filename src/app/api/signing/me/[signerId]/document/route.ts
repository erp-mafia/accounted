import { respondDocument } from '@/lib/signing/ceremony-routes'
import { withMemberSigner } from '@/lib/signing/route'

/** GET /api/signing/me/:signerId/document: the PDF being signed, inline; ?copy=signed the signed copy once everyone has signed. Only the request's own documents. */
export const GET = withMemberSigner<{ signerId: string }>('signing.member_document', {}, respondDocument)
