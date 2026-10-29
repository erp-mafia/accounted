/**
 * POST /api/v1/companies/{companyId}/corporate-meetings/{id}/decisions: add
 * or change a decision in unsigned minutes (operation
 * corporate-meetings.decisions.record).
 *
 * Contract, docs and rules live in src/lib/operations/corporate-meetings.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { corporateMeetingsDecisionsRecord } from '@/lib/operations/corporate-meetings'

export const POST = v1OperationHandler(corporateMeetingsDecisionsRecord)
