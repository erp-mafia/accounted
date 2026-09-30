import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { closeFiscalPeriodExternally } from '@/lib/core/bookkeeping/fiscal-year-service'
import { sessionFailureResponse } from '@/lib/operations/session'

// "Klarmarkera": mark an imported historical year as closed in a previous
// bookkeeping system. The rules live in period-service's
// markPeriodClosedExternally; lib/core/bookkeeping/fiscal-year-service.ts
// turns its refusals into registry codes, shared with the v1 operation
// fiscal-periods.close-external. Failures answer the canonical
// `{ error: { code, message } }` envelope (the year-end page and
// FiscalYearsManager read error.message).
export const POST = withRouteContext(
  'period.close_external',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const outcome = await closeFiscalPeriodExternally({ supabase, companyId, userId: user.id, log: opLog }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
