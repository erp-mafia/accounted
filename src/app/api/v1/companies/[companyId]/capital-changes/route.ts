/**
 * POST /api/v1/companies/{companyId}/capital-changes: record a nyemission,
 * fondemission or minskning (operation capital-changes.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { capitalChangesCreate } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(capitalChangesCreate)
