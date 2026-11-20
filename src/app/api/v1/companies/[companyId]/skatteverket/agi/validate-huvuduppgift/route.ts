/**
 * POST /api/v1/companies/{companyId}/skatteverket/agi/validate-huvuduppgift:
 * pre-validate an AGI huvuduppgift at Skatteverket (operation skatteverket.agi-validate-huvuduppgift).
 *
 * Contract and docs live in src/lib/operations/skatteverket-helpers.ts; the
 * Skatteverket call goes through the extension's registry services
 * (src/lib/skatteverket/extension-actions.ts), so the extension registry is
 * initialized first.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { skatteverketAgiValidateHuvuduppgift } from '@/lib/operations/skatteverket-helpers'

export const POST = v1OperationHandler(skatteverketAgiValidateHuvuduppgift)
