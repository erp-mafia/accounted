/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/send-peppol: send a
 * customer invoice as a Peppol e-invoice through the access point
 * (operation invoices.send-peppol). The network is contacted on commit only;
 * ?dry_run=true validates the document with reads.
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesSendPeppol } from '@/lib/operations/peppol'

// Registers the configured access point adapter and wires the event bus the
// issuance of a draft emits on.
ensureInitialized()

// The connector transport waits up to 60 s for the hosted access point per
// call (lookup, submit).
export const maxDuration = 90

export const POST = v1OperationHandler(invoicesSendPeppol)
