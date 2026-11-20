import { NextResponse } from 'next/server'
import { unlockFiscalPeriod } from '@/lib/core/bookkeeping/fiscal-year-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'

// Unlock a locked, not closed, räkenskapsår. The refusal codes
// (PERIOD_NOT_FOUND, PERIOD_UNLOCK_CLOSED, PERIOD_UNLOCK_NOT_LOCKED) come from
// lib/core/bookkeeping/fiscal-year-service.ts, shared with the v1 operation
// fiscal-periods.unlock.
export const POST = withRouteContext(
  'period.unlock',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const outcome = await unlockFiscalPeriod({ supabase, companyId, userId: user.id, log: opLog }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
