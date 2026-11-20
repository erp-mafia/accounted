/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/versions
 *
 * Freeze an immutable årsredovisning version (operation
 * arsredovisning.create-version). Contract, docs and rules live in
 * src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningCreateVersion } from '@/lib/operations/arsredovisning'

export const POST = v1OperationHandler(arsredovisningCreateVersion)
