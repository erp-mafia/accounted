/**
 * POST /api/v1/companies/{companyId}/accrual-schedules: a periodisering set
 * up by hand from a posted verifikat or the ingående balans (operation
 * accrual-schedules.create).
 *
 * Contract, docs and rules live in src/lib/operations/accrual-schedules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accrualSchedulesCreate } from '@/lib/operations/accrual-schedules'

export const POST = v1OperationHandler(accrualSchedulesCreate)
