/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/attest-substitutes:
 * name a substitute for a supplier invoice attester for a period (operation
 * supplier-invoices.attest-substitutes.create). Owners and admins for
 * anyone, anyone else for themselves; ?dry_run=true validates and writes
 * nothing. The substitutes are read with GET .../attest-policy.
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-attest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesAttestSubstituteAdd } from '@/lib/operations/supplier-invoice-attest'

export const POST = v1OperationHandler(supplierInvoicesAttestSubstituteAdd)
