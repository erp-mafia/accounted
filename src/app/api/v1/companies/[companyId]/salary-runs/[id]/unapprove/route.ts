/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/unapprove: recall the
 * approval, approved back to review (operation salary-runs.unapprove).
 *
 * Contract, docs and rules live in src/lib/operations/salary-run-lifecycle.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryRunsUnapprove } from '@/lib/operations/salary-run-lifecycle'

export const POST = v1OperationHandler(salaryRunsUnapprove)
