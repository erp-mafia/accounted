/**
 * GET/PUT /api/v1/companies/{companyId}/supplier-invoices/attest-policy: the
 * company's attest policy for supplier invoices (operations
 * supplier-invoices.attest-policy.get and .update). Saving is for owners and
 * admins; ?dry_run=true validates and writes nothing.
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-attest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesAttestPolicyGet, supplierInvoicesAttestPolicyUpdate } from '@/lib/operations/supplier-invoice-attest'

export const GET = v1OperationHandler(supplierInvoicesAttestPolicyGet)
export const PUT = v1OperationHandler(supplierInvoicesAttestPolicyUpdate)
