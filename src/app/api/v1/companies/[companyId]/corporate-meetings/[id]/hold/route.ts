/**
 * POST /api/v1/companies/{companyId}/corporate-meetings/{id}/hold: mark a
 * meeting as held (operation corporate-meetings.hold).
 *
 * Contract, docs and rules live in src/lib/operations/corporate-meetings.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { corporateMeetingsHold } from '@/lib/operations/corporate-meetings'

export const POST = v1OperationHandler(corporateMeetingsHold)
