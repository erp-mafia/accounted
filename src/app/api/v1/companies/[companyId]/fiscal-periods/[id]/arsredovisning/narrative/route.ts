/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/narrative
 *
 * Edit the årsredovisning texts (operation arsredovisning.update-narrative).
 * Contract, docs and rules live in src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningUpdateNarrative } from '@/lib/operations/arsredovisning'

export const POST = v1OperationHandler(arsredovisningUpdateNarrative)
