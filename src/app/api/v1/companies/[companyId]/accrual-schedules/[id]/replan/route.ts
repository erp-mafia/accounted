/**
 * POST /api/v1/companies/{companyId}/accrual-schedules/{id}/replan:
 * re-plan the months of a periodisering that are not yet posted (operation
 * accrual-schedules.replan).
 *
 * Contract, docs and rules live in src/lib/operations/accrual-schedules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accrualSchedulesReplan } from '@/lib/operations/accrual-schedules'

export const POST = v1OperationHandler(accrualSchedulesReplan)
