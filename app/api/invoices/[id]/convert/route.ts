import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { convertToInvoice } from '@/lib/invoices/convert-to-invoice'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * POST /api/invoices/[id]/convert
 *
 * Converts a proforma invoice or an accepted quote (offert) to a real
 * invoice. The shared implementation (lib/invoices/convert-to-invoice.ts)
 * copies the data, generates an F-series number LAST, marks a proforma
 * cancelled and a quote accepted; the new invoice links back through
 * converted_from_id.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.convert',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const result = await convertToInvoice({
      supabase,
      userId: user.id,
      companyId,
      sourceId: id,
    })

    if (!result.ok) {
      if (result.code === 'INVOICE_CONVERT_FAILED') {
        log.error('invoice conversion failed', result.cause as Error, { sourceId: id })
        return NextResponse.json({ error: getUserErrorMessage(result.cause) }, { status: 500 })
      }
      return errorResponseFromCode(result.code, log, { requestId })
    }

    return NextResponse.json({ data: result.invoice })
  },
  { requireWrite: true },
)
