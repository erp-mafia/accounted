/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/send-payslips: email
 * every employee on the run a secure payslip link
 * (operation salary-runs.send-payslips).
 *
 * Contract, docs and rules live in src/lib/operations/salary-run-lifecycle.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryRunsSendPayslips } from '@/lib/operations/salary-run-lifecycle'

export const POST = v1OperationHandler(salaryRunsSendPayslips)
