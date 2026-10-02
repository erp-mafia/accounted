/**
 * POST /api/v1/companies/{companyId}/skattekonto/sync: fetch the skattekonto
 * from Skatteverket now (operation skattekonto.sync).
 *
 * Contract and docs live in src/lib/operations/skatteverket-helpers.ts; the
 * Skatteverket call goes through the extension's registry services
 * (src/lib/skatteverket/extension-actions.ts), so the extension registry is
 * initialized first.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { skattekontoSync } from '@/lib/operations/skatteverket-helpers'

ensureInitialized()

export const POST = v1OperationHandler(skattekontoSync)
