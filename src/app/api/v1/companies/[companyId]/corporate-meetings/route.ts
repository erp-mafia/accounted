/**
 * GET /api/v1/companies/{companyId}/corporate-meetings: the company's
 * stämmor, styrelsemöten and per capsulam decisions (operation
 * corporate-meetings.list).
 * POST: plan a meeting, an årsstämma prefilled (operation corporate-meetings.create).
 *
 * Contract, docs and rules live in src/lib/operations/corporate-meetings.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { corporateMeetingsCreate, corporateMeetingsList } from '@/lib/operations/corporate-meetings'

export const GET = v1OperationHandler(corporateMeetingsList)
export const POST = v1OperationHandler(corporateMeetingsCreate)
