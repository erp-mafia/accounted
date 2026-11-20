/**
 * GET /api/v1/companies/{companyId}/corporate-meetings/{id}: one meeting with
 * its minutes, röstlängd, signers and the role changes its elections make
 * (operation corporate-meetings.get).
 * PATCH: change a meeting whose minutes are unsigned (operation corporate-meetings.update).
 *
 * Contract, docs and rules live in src/lib/operations/corporate-meetings.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { corporateMeetingsGet, corporateMeetingsUpdate } from '@/lib/operations/corporate-meetings'

export const GET = v1OperationHandler(corporateMeetingsGet)
export const PATCH = v1OperationHandler(corporateMeetingsUpdate)
