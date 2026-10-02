/**
 * PATCH /api/v1/companies/{companyId}/settings/bookkeeping-lock: the
 * company-wide lock date and auto-lock days (operation
 * settings.update-bookkeeping-lock, src/lib/operations/company-settings.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { settingsUpdateBookkeepingLock } from '@/lib/operations/company-settings'

export const PATCH = v1OperationHandler(settingsUpdateBookkeepingLock)
