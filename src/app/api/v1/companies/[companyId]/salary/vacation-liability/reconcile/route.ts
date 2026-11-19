/**
 * POST /api/v1/companies/{companyId}/salary/vacation-liability/reconcile:
 * book the semesterlöneskuld at its computed value on a date (operation
 * salary.vacation-liability.reconcile). `?dry_run=true` previews the
 * verifikat and writes nothing.
 *
 * Contract, docs and rules live in src/lib/operations/salary-vacation-liability.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryVacationLiabilityReconcile } from '@/lib/operations/salary-vacation-liability'

export const POST = v1OperationHandler(salaryVacationLiabilityReconcile)
