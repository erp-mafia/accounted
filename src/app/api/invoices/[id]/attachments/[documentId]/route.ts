import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { unlinkInvoiceAttachment } from '@/lib/invoices/invoice-attachments'

/**
 * DELETE /api/invoices/[id]/attachments/[documentId]
 *
 * Takes a file off a draft invoice before it is sent (crm#1269). Only the
 * link goes; the document stays in the archive. Once the invoice is sent its
 * attachments are fixed: 409 INVOICE_ATTACHMENTS_FIXED.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string; documentId: string }> }>(
  'invoice.attachments.unlink',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id, documentId } = await params
    const uuid = z.string().uuid()
    if (!uuid.safeParse(id).success || !uuid.safeParse(documentId).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice and document ids must be UUIDs.' },
      })
    }

    const result = await unlinkInvoiceAttachment(supabase, companyId!, id, documentId)
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId })
    }
    return NextResponse.json({ data: { document_id: documentId, removed: true } })
  },
  { requireWrite: true },
)
