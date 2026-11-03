/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/pdf
 *
 * Render the invoice as a PDF and return it as `application/pdf`. Mirrors
 * the dashboard's internal `/api/invoices/[id]/pdf` so a downloaded PDF is
 * byte-equivalent across surfaces.
 *
 * Behavior:
 *   - Drafts (no invoice_number): the filename uses `utkast-<id-slice>`. The
 *     PDF is still rendered: useful for "preview before send" workflows.
 *   - Sent / paid / overdue / cancelled / credit notes: full PDF with the
 *     persisted invoice number.
 *   - Credit notes: the filename identifies the document as a kreditfaktura and the original
 *     invoice's löpnummer is embedded (ML 17 kap 22-23§ back-reference).
 *   - Delivery notes: PDF is permitted (read-only, no compliance side effect).
 *
 * Read-only: no Idempotency-Key, no dry-run, scope `invoices:read`.
 */

import { z } from 'zod'
import { renderStoredInvoicePdf } from '@/lib/invoices/stored-invoice-pdf'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { fileResponse } from '@/lib/api/file-response'

registerEndpoint({
  operation: 'invoices.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices/:id/pdf',
  summary: 'Download the rendered invoice PDF.',
  description:
    'Returns the invoice as application/pdf. The descriptive filename contains company, customer, document type, invoice number or draft identifier, and invoice date. This endpoint is byte-equivalent to the dashboard download.',
  useWhen:
    'You need to fetch an invoice PDF for archival, forwarding to a customer outside the Accounted send flow, or attaching to an external workflow.',
  doNotUseFor:
    'Sending the invoice to the customer: use POST /invoices/{id}/send, which renders the PDF, emails it, and archives it as a verifikationsunderlag in one atomic step.',
  pitfalls: [
    'Drafts (no invoice_number yet) render with an "utkast" filename. The PDF carries no F-series number: do not treat it as a finalized invoice.',
    'PDF rendering can take several hundred milliseconds for invoices with many line items. Cache on the client if requesting repeatedly.',
    'Credit notes embed the original invoice\'s löpnummer per ML 17 kap 22-23§: if the original was hard-deleted (not possible via Accounted but theoretically via a manual DB edit), the reference is omitted.',
    'An invoice without a customer (customer_id null, e.g. its customer was deleted) has no buyer to print: 409 INVOICE_CUSTOMER_MISSING. Set customer_id on the draft or delete it.',
  ],
  example: {
    response: {
      // Binary response: OpenAPI declares format: binary via response.contentType.
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
    success: z.unknown(), // Marker: binary response, see contentType.
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

    // The loader and render are shared with gnubok_get_invoice_pdf
    // (lib/invoices/stored-invoice-pdf.ts), so the agent's file and this
    // download are the same document.
    const rendered = await renderStoredInvoicePdf(ctx.supabase, ctx.companyId!, invoiceId, ctx.log)
    if (!rendered.ok) {
      if (rendered.code === 'DB_ERROR') {
        return v1ErrorResponse(rendered.error, ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode(rendered.code, ctx.log, {
        requestId: ctx.requestId,
        ...(rendered.details ? { details: rendered.details } : {}),
      })
    }
    const pdfBuffer = rendered.buffer
    const filename = rendered.filename

    const uint8Array = new Uint8Array(pdfBuffer)
    return fileResponse(uint8Array, {
      filename: filename,
      contentType: 'application/pdf',
      cacheControl: 'private, no-store',
      headers: {
        'Content-Length': String(pdfBuffer.length),
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
