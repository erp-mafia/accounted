import { NextResponse } from 'next/server'
import { lockPeriod } from '@/lib/core/bookkeeping/period-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

export const POST = withRouteContext(
  'period.lock',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const period = await lockPeriod(supabase, companyId!, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      // lockPeriod's refusals carry their codes (PERIOD_NOT_FOUND,
      // PERIOD_ALREADY_CLOSED, PERIOD_LOCK_ALREADY_LOCKED, and
      // PERIOD_HAS_UNBOOKED_TRANSACTIONS with the count in its sentence).
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)
