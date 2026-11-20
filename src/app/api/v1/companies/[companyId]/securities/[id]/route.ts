/**
 * PATCH /api/v1/companies/{companyId}/securities/{id}: change a ställd
 * säkerhet or eventualförpliktelse, or release it with valid_to (operation
 * securities.update).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { securitiesUpdate } from '@/lib/operations/commitments'

export const PATCH = v1OperationHandler(securitiesUpdate)
