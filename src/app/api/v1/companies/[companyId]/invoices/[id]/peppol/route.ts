/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/peppol: can this invoice
 * be sent over Peppol, to which participant, and what is missing (operation
 * invoices.peppol-readiness).
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesPeppolReadiness } from '@/lib/operations/peppol'

export const GET = v1OperationHandler(invoicesPeppolReadiness)
