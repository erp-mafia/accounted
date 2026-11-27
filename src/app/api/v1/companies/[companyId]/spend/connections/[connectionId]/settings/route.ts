/**
 * PATCH /api/v1/companies/{companyId}/spend/connections/{connectionId}/settings (operation spend.update-settings).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendUpdateSettings } from '@/lib/operations/spend'

export const PATCH = v1OperationHandler(spendUpdateSettings)
