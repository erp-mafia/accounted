/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}/expense-claims:
 * put the employee's open expense claims (utlägg) on their payslip
 * (operation salary-runs.attach-expense-claims).
 *
 * Contract, docs and rules live in src/lib/operations/salary-run-lifecycle.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryRunsAttachExpenseClaims } from '@/lib/operations/salary-run-lifecycle'

export const POST = v1OperationHandler(salaryRunsAttachExpenseClaims)
