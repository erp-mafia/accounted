/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/peppol/deliveries: the
 * invoice's Peppol deliveries and their network status (operation
 * invoices.peppol-deliveries).
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesPeppolDeliveries } from '@/lib/operations/peppol'

ensureInitialized()

export const GET = v1OperationHandler(invoicesPeppolDeliveries)
