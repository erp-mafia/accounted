/**
 * POST /api/v1/companies/{companyId}/peppol/access-request: ask the
 * operators to switch on Peppol for the company (operation
 * peppol.request-access).
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { peppolRequestAccess } from '@/lib/operations/peppol'

ensureInitialized()

export const POST = v1OperationHandler(peppolRequestAccess)
