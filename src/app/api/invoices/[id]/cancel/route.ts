import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { cancelQuoteOrProforma } from '@/lib/invoices/cancel-quote-or-proforma'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/invoices/[id]/cancel
 *
 * Makulerar a quote or a proforma invoice. A sales invoice is refused: a
 * draft is deleted (DELETE /api/invoices/[id]) and an issued one credited.
 * Cancelling an already cancelled document answers with it unchanged.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const result = await cancelQuoteOrProforma({
      supabase,
      companyId,
      userId: user.id,
      invoiceId: id,
    })

    if (!result.ok) {
      if (result.code === 'DB_ERROR') {
        log.error('invoice cancel failed', result.cause, { invoiceId: id })
        return errorResponse(result.cause, log, { requestId })
      }
      if (result.code === 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA') {
        return errorResponseFromCode(result.code, log, {
          requestId,
          details: { documentType: result.documentType },
        })
      }
      return errorResponseFromCode(result.code, log, { requestId })
    }

    return NextResponse.json({ data: result.invoice })
  },
  { requireWrite: true },
)
