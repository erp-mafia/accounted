/**
 * /api/v1/companies/{companyId}/settings: the company settings.
 *
 * GET  : every setting the API can write, plus the fixed identity
 *        (operation settings.get).
 * PATCH: contact, invoicing, reminders, voucher series and feature toggles
 *        (operation settings.update). The tax profile and the bookkeeping
 *        lock have their own paths: ./tax-profile and ./bookkeeping-lock.
 *
 * Contracts and docs live in src/lib/operations/company-settings.ts; the
 * rules and side effects in lib/company/settings-service.ts, shared with the
 * dashboard's PUT /api/settings.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { settingsGet, settingsUpdate } from '@/lib/operations/company-settings'

export const GET = v1OperationHandler(settingsGet)
export const PATCH = v1OperationHandler(settingsUpdate)
