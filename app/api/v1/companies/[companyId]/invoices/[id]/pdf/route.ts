/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/pdf
 *
 * Render the invoice as a PDF and return it as `application/pdf`. Mirrors
 * the dashboard's internal `/api/invoices/[id]/pdf` so a downloaded PDF is
 * byte-equivalent across surfaces.
 *
 * Behavior:
 *   - Drafts (no invoice_number): the filename uses `utkast-<id-slice>`. The
 *     PDF is still rendered — useful for "preview before send" workflows.
 *   - Sent / paid / overdue / cancelled / credit notes: full PDF with the
 *     persisted invoice number.
 *   - Credit notes: filename uses `kreditfaktura-` prefix and the original
 *     invoice's löpnummer is embedded (ML 17 kap 22–23§ back-reference).
 *   - Delivery notes: PDF is permitted (read-only, no compliance side effect).
 *
 * Read-only — no Idempotency-Key, no dry-run, scope `invoices:read`.
 */

import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

const INVOICE_PDF_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, status, document_type, ' +
  'currency, subtotal, vat_amount, total, vat_treatment, vat_rate, moms_ruta, ' +
  'reverse_charge_text, your_reference, our_reference, notes, credited_invoice_id, ' +
  'paid_amount, remaining_amount'

const PDF_FETCH_SELECT = `
  ${INVOICE_PDF_COLUMNS},
  customer:customers(*),
  items:invoice_items(*)
`

registerEndpoint({
  operation: 'invoices.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices/:id/pdf',
  summary: 'Download the rendered invoice PDF.',
  description:
    'Returns the invoice as application/pdf. The filename in Content-Disposition reflects the document type: faktura-<number>.pdf for sent invoices, kreditfaktura-<number>.pdf for credit notes, utkast-<id-slice>.pdf for drafts. This endpoint is byte-equivalent to the dashboard download.',
  useWhen:
    'You need to fetch an invoice PDF for archival, forwarding to a customer outside the gnubok send flow, or attaching to an external workflow.',
  doNotUseFor:
    'Sending the invoice to the customer — use POST /invoices/{id}/send, which renders the PDF, emails it, and archives it as a verifikationsunderlag in one atomic step.',
  pitfalls: [
    'Drafts (no invoice_number yet) render with an "utkast" filename. The PDF carries no F-series number — do not treat it as a finalized invoice.',
    'PDF rendering can take several hundred milliseconds for invoices with many line items. Cache on the client if requesting repeatedly.',
    'Credit notes embed the original invoice\'s löpnummer per ML 17 kap 22–23§ — if the original was hard-deleted (not possible via gnubok but theoretically via a manual DB edit), the reference is omitted.',
  ],
  example: {
    response: {
      // Binary response — OpenAPI declares format: binary via response.contentType.
      // Documented here for human readers.
      _note: 'Returns application/pdf binary stream.',
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.unknown(), // Marker — binary response, see contentType.
    contentType: 'application/pdf',
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.pdf',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(PDF_FETCH_SELECT)
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.pdf: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const typed = invoice as unknown as Invoice & {
      customer?: Customer
      items?: InvoiceItem[]
    }

    // company_settings is required by the PDF template (header, bank info,
    // entity-type-driven layout). Select * is intentional — see the rationale
    // in the :send route. Same flat owner-facing config object, no sensitive
    // columns.
    const { data: company, error: companyErr } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (companyErr || !company) {
      ctx.log.warn('invoices.pdf: company settings missing', {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const items = (typed.items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

    // Credit-note back-reference per ML 17 kap 22–23§. Best-effort — if the
    // original invoice was somehow deleted, the PDF template tolerates an
    // undefined value (the back-reference field is omitted from the layout).
    let originalInvoiceNumber: string | undefined
    if (typed.credited_invoice_id) {
      const { data: orig } = await ctx.supabase
        .from('invoices')
        .select('invoice_number')
        .eq('id', typed.credited_invoice_id)
        .eq('company_id', ctx.companyId!)
        .maybeSingle()
      if (orig) {
        originalInvoiceNumber = (orig as { invoice_number?: string }).invoice_number ?? undefined
      }
    }

    let pdfBuffer: Buffer
    try {
      const { branding } = prepareInvoicePdfRender(company as CompanySettings)
      pdfBuffer = await renderToBuffer(
        InvoicePDF({
          invoice: typed as Invoice,
          customer: typed.customer as Customer,
          items,
          company: company as CompanySettings,
          originalInvoiceNumber,
          branding,
        }),
      )
    } catch (err) {
      ctx.log.error('invoices.pdf: render failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_PDF_RENDER_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const isCreditNote = !!typed.credited_invoice_id
    const filenameNumber = typed.invoice_number ?? `utkast-${invoiceId.slice(0, 8)}`
    const filename = isCreditNote
      ? `kreditfaktura-${filenameNumber}.pdf`
      : typed.document_type === 'proforma'
        ? `proformafaktura-${filenameNumber}.pdf`
        : typed.document_type === 'delivery_note'
          ? `följesedel-${filenameNumber}.pdf`
          : `faktura-${filenameNumber}.pdf`

    const uint8Array = new Uint8Array(pdfBuffer)
    return new Response(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.length),
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
