/**
 * POST /api/v1/companies/{companyId}/accrual-schedules/{id}/cancel: undo a
 * periodisering set up by hand (operation accrual-schedules.cancel).
 *
 * Contract, docs and rules live in src/lib/operations/accrual-schedules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accrualSchedulesCancel } from '@/lib/operations/accrual-schedules'

export const POST = v1OperationHandler(accrualSchedulesCancel)
