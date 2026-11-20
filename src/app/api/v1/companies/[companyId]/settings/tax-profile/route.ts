/**
 * PATCH /api/v1/companies/{companyId}/settings/tax-profile: VAT, F-skatt,
 * employer registration, fiscal year, accounting method and share capital
 * (operation settings.update-tax-profile, src/lib/operations/company-settings.ts).
 * Regenerates the tax deadlines like the settings page does.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { settingsUpdateTaxProfile } from '@/lib/operations/company-settings'

export const PATCH = v1OperationHandler(settingsUpdateTaxProfile)
