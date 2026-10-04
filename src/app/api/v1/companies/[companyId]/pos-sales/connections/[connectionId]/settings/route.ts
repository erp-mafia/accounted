/**
 * PATCH /api/v1/companies/{companyId}/pos-sales/connections/{connectionId}/settings (operation pos-sales.update-settings).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesUpdateSettings } from '@/lib/operations/pos-sales'

export const PATCH = v1OperationHandler(posSalesUpdateSettings)
