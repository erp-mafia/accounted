import { withRouteContext } from '@/lib/api/with-route-context'
import { privateNoStore } from '@/lib/api/private-no-store'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { renderStoredSelfBillingPdf } from '@/lib/supplier-invoices/self-billing/document'

/**
 * GET /api/supplier-invoices/[id]/self-billing-pdf: the självfaktura the
 * company issued in the supplier's name (crm#1367), rendered from the stored
 * row. `?disposition=inline` opens it in the browser; anything else
 * downloads it. 404 when the invoice is not this company's or is an ordinary
 * supplier invoice (its document is the supplier's, in the archive).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.self_billing_pdf',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    let outcome: Awaited<ReturnType<typeof renderStoredSelfBillingPdf>>
    try {
      outcome = await renderStoredSelfBillingPdf(supabase, companyId, id)
    } catch (err) {
      log.error('self-billing PDF render failed', err as Error, { requestId, supplierInvoiceId: id })
      return privateNoStore(errorResponseFromCode('SI_SELF_BILL_DOCUMENT_UNAVAILABLE', log, { requestId }))
    }
    if (!outcome.ok) {
      const code = outcome.code === 'SI_SELF_BILL_NOT_SELF_BILLED' ? 'SI_NOT_FOUND' : outcome.code
      return privateNoStore(errorResponseFromCode(code, log, { requestId }))
    }
    const inline = new URL(request.url).searchParams.get('disposition') === 'inline'
    return fileResponse(new Uint8Array(outcome.buffer), {
      filename: outcome.filename,
      contentType: 'application/pdf',
      disposition: inline ? 'inline' : 'attachment',
      cacheControl: 'private, no-store',
      headers: { 'Content-Length': String(outcome.buffer.length), 'X-Content-Type-Options': 'nosniff' },
    })
  },
)
