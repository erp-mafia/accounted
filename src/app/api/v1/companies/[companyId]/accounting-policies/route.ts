/**
 * PATCH /api/v1/companies/{companyId}/accounting-policies: the K3 18.7 model
 * (operation company.accounting-policies.update).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { companyAccountingPoliciesUpdate } from '@/lib/operations/k3'

export const PATCH = v1OperationHandler(companyAccountingPoliciesUpdate)
