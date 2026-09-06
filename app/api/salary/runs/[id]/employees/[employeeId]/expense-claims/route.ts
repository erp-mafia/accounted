import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { addOpenExpenseClaimsToPayslip } from '@/lib/salary/expense-claim-lines'

ensureInitialized()

/**
 * "Lägg till öppna utlägg": put every registered, unscheduled expense claim
 * of the employee on this draft run's payslip as tax-free
 * expense_reimbursement lines (#2331). The server resolves the claims; the
 * client never sends amounts. Booking the run later marks exactly these
 * claims paid.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.employee.expense_claims.add',
  async (_request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId, log, requestId } = ctx

    const result = await addOpenExpenseClaimsToPayslip(supabase, {
      companyId,
      salaryRunId: id,
      employeeId,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
