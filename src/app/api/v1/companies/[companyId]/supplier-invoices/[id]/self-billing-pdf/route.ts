/**
 * GET /api/v1/companies/{companyId}/supplier-invoices/{id}/self-billing-pdf
 *
 * The självfaktura the company issued in the supplier's name (crm#1367),
 * rendered from the stored row and its frozen parties, as `application/pdf`.
 * The same document the dashboard downloads; the archived copy is the
 * verifikat's underlag in the document archive.
 *
 * Read-only: no Idempotency-Key, no dry-run, scope `suppliers:read`.
 */

import { z } from 'zod'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { fileResponse } from '@/lib/api/file-response'
import { renderStoredSelfBillingPdf } from '@/lib/supplier-invoices/self-billing/document'

registerEndpoint({
  operation: 'supplier-invoices.self-billing-pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/self-billing-pdf',
  summary: 'Download the self-billing invoice (självfaktura) PDF.',
  description:
    'Returns the self-billing invoice the company issued in the supplier\'s name as application/pdf: "Självfakturering", the number from the company\'s own series, both parties, the agreement and the acceptance clause. A credit note of one renders as its kreditfaktura.',
  useWhen:
    'You need the document of a self-billing invoice (is_self_billed=true) to send to the supplier or archive outside Accounted.',
  doNotUseFor:
    'An ordinary supplier invoice: its document is the supplier\'s own, in the document archive (document_id). That answers 404.',
  pitfalls: [
    'Only for is_self_billed=true; any other supplier invoice answers 404 SI_NOT_FOUND.',
    'Rendered from the parties frozen at issue, so later changes to the supplier card or the company settings do not change it.',
  ],
  example: {
    response: {
      _note: 'Returns application/pdf binary stream.',
    },
  },
  scope: 'suppliers:read',
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
  'supplier-invoices.self-billing-pdf',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier invoice id must be a UUID.' },
      })
    }

    let outcome: Awaited<ReturnType<typeof renderStoredSelfBillingPdf>>
    try {
      outcome = await renderStoredSelfBillingPdf(ctx.supabase, ctx.companyId!, idParse.data)
    } catch (err) {
      ctx.log.error('supplier-invoices.self-billing-pdf: render failed', err as Error, { supplierInvoiceId: idParse.data })
      return v1ErrorResponseFromCode('SI_SELF_BILL_DOCUMENT_UNAVAILABLE', ctx.log, { requestId: ctx.requestId })
    }
    if (!outcome.ok) {
      const code = outcome.code === 'SI_SELF_BILL_NOT_SELF_BILLED' ? 'SI_NOT_FOUND' : outcome.code
      return v1ErrorResponseFromCode(code, ctx.log, { requestId: ctx.requestId })
    }

    return fileResponse(new Uint8Array(outcome.buffer), {
      filename: outcome.filename,
      contentType: 'application/pdf',
      cacheControl: 'private, no-store',
      headers: { 'Content-Length': String(outcome.buffer.length), 'X-Request-Id': ctx.requestId },
    })
  },
)
