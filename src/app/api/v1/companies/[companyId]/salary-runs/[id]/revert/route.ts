/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/revert: review back to
 * draft (operation salary-runs.revert).
 *
 * Contract, docs and rules live in src/lib/operations/salary-run-lifecycle.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryRunsRevert } from '@/lib/operations/salary-run-lifecycle'

export const POST = v1OperationHandler(salaryRunsRevert)
