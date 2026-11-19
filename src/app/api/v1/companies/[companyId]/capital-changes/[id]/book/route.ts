/**
 * POST /api/v1/companies/{companyId}/capital-changes/{id}/book: book a
 * nyemission payment or the registration of a capital change (operation
 * capital-changes.book).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { capitalChangesBook } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(capitalChangesBook)
