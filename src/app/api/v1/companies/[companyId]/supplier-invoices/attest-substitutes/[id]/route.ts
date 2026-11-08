/**
 * DELETE /api/v1/companies/{companyId}/supplier-invoices/attest-substitutes/{id}:
 * remove a substitute (operation supplier-invoices.attest-substitutes.delete).
 * Owners and admins remove any, the attester who is away their own.
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-attest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesAttestSubstituteRemove } from '@/lib/operations/supplier-invoice-attest'

export const DELETE = v1OperationHandler(supplierInvoicesAttestSubstituteRemove)
