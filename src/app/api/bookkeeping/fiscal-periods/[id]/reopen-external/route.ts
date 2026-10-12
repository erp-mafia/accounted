import { NextResponse } from 'next/server'
import { reopenExternallyClosedFiscalPeriod } from '@/lib/core/bookkeeping/fiscal-year-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'

// Undo "klarmarkera": reopen a period that was marked as closed in a previous
// bookkeeping system. The refusal codes (PERIOD_NOT_FOUND,
// PERIOD_REOPEN_NOT_CLOSED, PERIOD_REOPEN_NOT_EXTERNAL) come from
// lib/core/bookkeeping/fiscal-year-service.ts, shared with the v1 operation
// fiscal-periods.reopen-external (FiscalYearsManager surfaces error.message).
export const POST = withRouteContext(
  'period.reopen_external',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const outcome = await reopenExternallyClosedFiscalPeriod(
      { supabase, companyId, userId: user.id, log: opLog },
      id,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
