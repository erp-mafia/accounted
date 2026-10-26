/**
 * /api/v1/companies/{companyId}/settings/skattekonto-account: the ledger
 * account the skattekonto runs on, 1630 or 2012 for an enskild firma (PH 175).
 *
 * GET  : the account in use, the stored choice, the choices and their
 *        balances (operation settings.get-skattekonto-account).
 * PATCH: store the choice (operation settings.update-skattekonto-account).
 *
 * Contracts and docs live in src/lib/operations/skattekonto-account.ts; the
 * rules in lib/skatteverket/skattekonto-account-service.ts, shared with the
 * dashboard's /api/settings/skattekonto-account.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { settingsGetSkattekontoAccount, settingsUpdateSkattekontoAccount } from '@/lib/operations/skattekonto-account'

export const GET = v1OperationHandler(settingsGetSkattekontoAccount)
export const PATCH = v1OperationHandler(settingsUpdateSkattekontoAccount)
