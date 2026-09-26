import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { attachOpenExpenseClaims } from '@/lib/salary/expense-claim-lines'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * "Lägg till öppna utlägg": put every registered, unscheduled expense claim
 * of the employee on this draft run's payslip as tax-free
 * expense_reimbursement lines (#2331). The server resolves the claims; the
 * client never sends amounts. Booking the run later marks exactly these
 * claims paid. The rules live in lib/salary/expense-claim-lines.ts, shared
 * with the v1 operation salary-runs.attach-expense-claims and
 * gnubok_attach_salary_expense_claims.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.employee.expense_claims.add',
  async (_request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId, log, requestId, user } = ctx

    const outcome = await attachOpenExpenseClaims(
      { supabase, companyId, userId: user.id, log },
      { salaryRunId: id, employeeId },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
