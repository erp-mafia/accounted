/**
 * GET /api/v1/companies/{companyId}/measures/{measureId}/explain: what one
 * defined figure adds, down to the journal lines or invoices behind it, with
 * typed handles (operation measures.explain, src/lib/operations/measures.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { measuresExplain } from '@/lib/operations/measures'

export const GET = v1OperationHandler(measuresExplain)
