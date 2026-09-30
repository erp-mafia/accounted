/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/peppol: can this invoice
 * be sent over Peppol, to which participant, and what is missing (operation
 * invoices.peppol-readiness).
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesPeppolReadiness } from '@/lib/operations/peppol'

// Registers the configured access point adapter, so the transport gate
// reports the truth for this process.
ensureInitialized()

export const GET = v1OperationHandler(invoicesPeppolReadiness)
