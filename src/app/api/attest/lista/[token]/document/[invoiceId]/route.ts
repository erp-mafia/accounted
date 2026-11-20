import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withAttestBatchToken } from '@/lib/supplier-invoices/attest-batch-route'
import { attestInvoiceDocumentResponse } from '@/lib/supplier-invoices/attest-link-route'

/**
 * GET /api/attest/lista/:token/document/:invoiceId: the supplier's own
 * document of one invoice the batched mail listed, for its page without a
 * login. An invoice the link does not list answers 404.
 */
export const GET = withAttestBatchToken<{ token: string; invoiceId: string }>(
  'attest_batch.document',
  async (_request, { batch, service, log, requestId }, { invoiceId }) => {
    if (!batch.invoice_ids.includes(invoiceId)) {
      return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'invoice not listed in the attest batch' })
    }
    return attestInvoiceDocumentResponse(service, batch.company_id, invoiceId, log, requestId)
  },
)
