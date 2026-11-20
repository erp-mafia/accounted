/**
 * GET /api/v1/companies/{companyId}/supplier-invoices/{id}/attestations: where
 * the attest of one supplier invoice stands under the company's attest policy,
 * with every decision (operation supplier-invoices.attestations.list).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-attest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesAttestationsList } from '@/lib/operations/supplier-invoice-attest'

export const GET = v1OperationHandler(supplierInvoicesAttestationsList)
