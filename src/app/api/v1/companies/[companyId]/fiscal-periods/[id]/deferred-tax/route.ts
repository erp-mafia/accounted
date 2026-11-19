/**
 * PUT /api/v1/companies/{companyId}/fiscal-periods/{id}/deferred-tax: the K3 deferred tax inputs
 * (operation fiscal-periods.deferred-tax.set).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsDeferredTaxSet } from '@/lib/operations/k3'

export const PUT = v1OperationHandler(fiscalPeriodsDeferredTaxSet)
