import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { validateBody } from '@/lib/api/validate'
import { InvoicePreviewSchema } from '@/lib/api/schemas'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { describeInvoicePaymentQr } from '@/lib/invoices/payment-qr'
import { buildInvoicePreviewDraft } from '@/lib/invoices/preview-draft'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { contentDisposition } from '@/lib/api/content-disposition'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/invoices/preview-pdf
 *
 * Renders the invoice editor's draft (InvoicePreviewSchema) as the PDF it
 * becomes, without saving anything: the same render entry point and the
 * same inputs as the write path (lib/invoices/preview-draft.ts). Returns the
 * PDF inline.
 *
 * A half-filled form renders: no customer, no rows or no payee prints a
 * placeholder instead of a 400. Malformed input is still a 400.
 *
 * Response headers for the editor:
 *  - X-Invoice-Page-Count: the number of pages of this PDF.
 *  - X-Invoice-Qr: the payment QR code it carries (bank_app, swish,
 *    payment_link) or why it has none (none:<reason>, the reason codes of
 *    lib/invoices/payment-qr.ts).
 *  - X-Invoice-Missing: what the draft still lacks, comma separated
 *    (customer, rows, payee); absent when nothing is missing.
 *  - X-Invoice-Exchange-Rate / X-Invoice-Exchange-Rate-Date: on a foreign
 *    currency, the rate of the SEK amounts. Preliminary on a draft (the
 *    saved invoice fetches its own); the original's on a credit preview.
 */
export const POST = withRouteContext('invoice.preview_pdf', async (request, {
  supabase,
  user,
  companyId,
  log,
  requestId,
}) => {
  const validation = await validateBody(request, InvoicePreviewSchema, { log, operation: 'invoice.preview_pdf' })
  if (!validation.success) return privateNoStore(validation.response)

  const built = await buildInvoicePreviewDraft({
    supabase,
    companyId,
    userId: user.id,
    input: validation.data,
  })
  if (!built.ok) {
    return privateNoStore(errorResponseFromCode(built.code, log, { requestId, details: built.details }))
  }
  const { draft } = built

  try {
    const { buffer, paymentQr, pageCount } = await renderInvoicePdfBuffer({
      invoice: draft.invoice,
      customer: draft.customer,
      items: draft.items,
      company: draft.company,
      originalInvoiceNumber: draft.originalInvoiceNumber,
      isPreview: true,
      // A draft without a payee still renders; X-Invoice-Missing says so.
      paymentAccountRequired: false,
      payee: draft.payee,
    })
    const filename = invoicePdfFilename({
      companyName: draft.company.company_name,
      customerName: draft.customer.name,
      invoiceNumber: draft.invoice.invoice_number,
      invoiceId: draft.invoice.id,
      invoiceDate: draft.invoice.invoice_date,
      documentType: draft.invoice.document_type,
      isCreditNote: !!draft.invoice.credited_invoice_id,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('inline', filename),
      'Cache-Control': 'private, no-store',
      'X-Invoice-Page-Count': String(pageCount),
      'X-Invoice-Qr': describeInvoicePaymentQr(paymentQr),
    }
    if (draft.missing.length > 0) headers['X-Invoice-Missing'] = draft.missing.join(',')
    if (draft.exchangeRate) {
      headers['X-Invoice-Exchange-Rate'] = String(draft.exchangeRate.rate)
      if (draft.exchangeRate.date) headers['X-Invoice-Exchange-Rate-Date'] = draft.exchangeRate.date
    }

    return new Response(new Uint8Array(buffer), { headers })
  } catch (error) {
    log.error('invoice preview PDF generation failed', error, { requestId })
    return NextResponse.json(
      { error: 'Kunde inte generera PDF-förhandsgranskning' },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }
})
