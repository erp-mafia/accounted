/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/reject: reject
 * (neka) the attest of a supplier invoice, with an optional comment; the
 * attest round starts over (operation supplier-invoices.reject).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-attest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesReject } from '@/lib/operations/supplier-invoice-attest'

export const POST = v1OperationHandler(supplierInvoicesReject)
