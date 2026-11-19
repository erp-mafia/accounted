import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { detachInvoiceUnderlag } from '@/lib/invoices/invoice-underlag'
import { UUID_RE } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * DELETE /api/invoices/[id]/underlag/[documentId]: takes a document off the
 * invoice's underlag (accounted#42), in any state of the invoice. Only the
 * link goes; the document stays in the archive with its own verifikat.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string; documentId: string }> }>(
  'invoice.underlag.detach',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id, documentId } = await params
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'INVOICE_NOT_FOUND' }, log, requestId)
    if (!UUID_RE.test(documentId)) {
      return sessionFailureResponse({ ok: false, code: 'INVOICE_UNDERLAG_NOT_FOUND' }, log, requestId)
    }
    const outcome = await detachInvoiceUnderlag(
      { supabase, companyId: companyId! },
      { invoice_id: id, document_id: documentId },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
