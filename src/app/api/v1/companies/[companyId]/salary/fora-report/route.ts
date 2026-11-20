/**
 * GET /api/v1/companies/{companyId}/salary/fora-report: who is reported to
 * Fora for a payment month, with what code and pay (operation
 * salary-runs.fora-report.get). Summary only; the file is the salary run page's
 * download.
 *
 * Contract, docs and rules live in src/lib/operations/salary-fora-report.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { salaryForaReportGet } from '@/lib/operations/salary-fora-report'

export const GET = v1OperationHandler(salaryForaReportGet)
