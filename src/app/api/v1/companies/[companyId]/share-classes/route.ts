/**
 * POST /api/v1/companies/{companyId}/share-classes: add a share class
 * (operation share-classes.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { shareClassesCreate } from '@/lib/operations/bolaget'

export const POST = v1OperationHandler(shareClassesCreate)
