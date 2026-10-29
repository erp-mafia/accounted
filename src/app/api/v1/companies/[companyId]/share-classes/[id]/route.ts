/**
 * PATCH /api/v1/companies/{companyId}/share-classes/{id}: change a share
 * class's name, votes or förbehåll (operation share-classes.update).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { shareClassesUpdate } from '@/lib/operations/bolaget'

export const PATCH = v1OperationHandler(shareClassesUpdate)
