import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { markSalaryRunPaid } from '@/lib/salary/mark-paid'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * approved → paid (payment confirmation). The rule is lib/salary/mark-paid.ts,
 * shared with the v1 :mark-paid verb and gnubok_mark_salary_run_paid. The
 * optional body { confirm_payment_date_ahead: true } is the run page's answer
 * to "Har lönen redan betalats ut?" when the payment date has not come yet;
 * without it such a run is refused (crm#1216).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.paid',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { confirm_payment_date_ahead?: unknown } | null

    const outcome = await markSalaryRunPaid({ supabase, companyId: companyId! }, id, {
      confirmPaymentDateAhead: body?.confirm_payment_date_ahead === true,
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
