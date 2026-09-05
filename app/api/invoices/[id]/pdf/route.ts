import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { invoicePdfFilename, paymentConfirmationPdfFilename } from '@/lib/invoices/pdf-filename'
import { isPaymentConfirmationEligible } from '@/lib/invoices/payment-confirmation'
import { contentDisposition } from '@/lib/api/content-disposition'
import type { Invoice, InvoiceItem, Customer, CompanySettings } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'

/**
 * `?disposition=inline` serves the PDF for in-browser review instead of forcing
 * a download (#1190): reviewing an invoice should not mean opening a file from
 * the Downloads folder. Anything else, including a missing or malformed value,
 * keeps the download behaviour every existing caller relies on.
 */
function resolveDisposition(request: Request): 'inline' | 'attachment' {
  const requested = new URL(request.url).searchParams.get('disposition')
  return requested === 'inline' ? 'inline' : 'attachment'
}

/**
 * `?variant=paid` asks for the betalningsbekräftelse (#1693): the same
 * re-render, but refused unless the faktura is fully paid and named as a
 * payment confirmation rather than as the invoice. It is always a fresh
 * render; the archived original in the delivery history is never involved.
 */
function resolveVariant(request: Request): 'invoice' | 'paid' {
  const requested = new URL(request.url).searchParams.get('variant')
  return requested === 'paid' ? 'paid' : 'invoice'
}

/** `?probe=1` asks only whether the render would be refused; see the handler. */
function isProbe(request: Request): boolean {
  return new URL(request.url).searchParams.get('probe') === '1'
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.pdf',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
  const { id } = await params

  // withRouteContext resolves companyId from the authenticated user's active
  // membership. Explicit company filters remain mandatory defense in depth.

  // Fetch invoice with customer and items
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*),
      items:invoice_items(*)
    `)
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) {
    return NextResponse.json(
      { error: 'Invoice not found' },
      { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  const variant = resolveVariant(request)
  if (variant === 'paid' && !isPaymentConfirmationEligible(invoice as Invoice)) {
    return privateNoStore(errorResponseFromCode('INVOICE_PAYMENT_CONFIRMATION_NOT_PAID', log, {
      requestId,
      details: { currentStatus: (invoice as Invoice).status },
    }))
  }

  // Fetch company settings
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (companyError || !company) {
    return NextResponse.json(
      { error: 'Company settings not found' },
      { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, invoice as Invoice)) {
    return privateNoStore(errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', log, {
      requestId,
      details: { currency: (invoice as Invoice).currency },
    }))
  }

  // `?probe=1`: every refusal above has been checked, so answer without
  // rendering. The in-app preview asks this first, from a fetch whose JSON
  // refusal it can show as a message, and only then points the new tab at the
  // real inline URL. Navigating the tab straight here showed the refusal
  // envelope as raw JSON in that tab.
  if (isProbe(request)) {
    return new NextResponse(null, { status: 204, headers: PRIVATE_NO_STORE_HEADERS })
  }

  // Sort items by sort_order
  const items = (invoice.items as InvoiceItem[]).sort((a, b) => a.sort_order - b.sort_order)

  // If this is a credit note, fetch the original invoice number
  let originalInvoiceNumber: string | undefined
  if (invoice.credited_invoice_id) {
    const { data: originalInvoice } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoice.credited_invoice_id)
      .eq('company_id', companyId)
      .single()

    if (originalInvoice) {
      originalInvoiceNumber = originalInvoice.invoice_number
    }
  }

  try {
    // Generate PDF
    const { branding, company: renderCompany } = await prepareInvoicePdfRender(
      company as CompanySettings,
      (invoice as Invoice).currency,
      {
        paymentAccountRequired: invoiceRequiresPaymentAccount(invoice as Invoice),
        payee: (invoice as Invoice).payment_details ?? null,
      },
    )
    const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, invoice as Invoice)
    const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(invoice as Invoice)
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: invoice as Invoice,
        customer: invoice.customer as Customer,
        items,
        company: renderCompany,
        originalInvoiceNumber,
        branding,
        swishQrDataUrl,
        paymentLinkQrDataUrl,
      })
    )

    // Convert Node.js Buffer to Uint8Array for Response
    const uint8Array = new Uint8Array(pdfBuffer)

    // Return PDF as response
    const isCreditNote = !!invoice.credited_invoice_id
    const filename = variant === 'paid'
      ? paymentConfirmationPdfFilename(invoice.invoice_number)
      : invoicePdfFilename({
          companyName: (company as CompanySettings).company_name,
          customerName: (invoice.customer as Customer).name,
          invoiceNumber: invoice.invoice_number,
          invoiceId: invoice.id,
          invoiceDate: invoice.invoice_date,
          documentType: invoice.document_type,
          isCreditNote,
        })

    return new NextResponse(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition(resolveDisposition(request), filename),
        'Content-Length': pdfBuffer.length.toString(),
        'Cache-Control': 'private, no-store',
        // The filename is derived from company/customer/invoice data, so the
        // Content-Type must not be re-sniffed from the bytes when the browser
        // renders this inline.
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    log.error('invoice PDF generation failed', error, { requestId, invoiceId: id })
    return NextResponse.json(
      { error: error instanceof Error ? getUserErrorMessage(error) : 'PDF generation failed' },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }
  },
)
