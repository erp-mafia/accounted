/**
 * GET /api/v1/companies/{companyId}/securities: ställda säkerheter and
 * eventualförpliktelser with the årsredovisning note texts (operation
 * securities.list).
 * POST: register one (operation securities.create).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { securitiesCreate, securitiesList } from '@/lib/operations/commitments'

export const GET = v1OperationHandler(securitiesList)
export const POST = v1OperationHandler(securitiesCreate)
