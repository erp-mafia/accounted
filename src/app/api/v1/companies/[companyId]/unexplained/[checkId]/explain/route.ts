/**
 * GET /api/v1/companies/{companyId}/unexplained/{checkId}/explain: one result
 * of a check broken into parts and the items behind them, with typed handles
 * (operation unexplained.explain, src/lib/operations/unexplained.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { unexplainedExplain } from '@/lib/operations/unexplained'

export const GET = v1OperationHandler(unexplainedExplain)
