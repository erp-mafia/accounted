import { attestInvoiceDocumentResponse, withAttestLinkToken } from '@/lib/supplier-invoices/attest-link-route'

/**
 * GET /api/attest/:token/document: the supplier's own invoice document, for
 * the attest page a link opens without a login. Only the document of the
 * invoice the link names (attestInvoiceDocumentResponse).
 */
export const GET = withAttestLinkToken<{ token: string }>('attest_link.document', async (_request, { link, service, log, requestId }) =>
  attestInvoiceDocumentResponse(service, link.company_id, link.supplier_invoice_id, log, requestId),
)
