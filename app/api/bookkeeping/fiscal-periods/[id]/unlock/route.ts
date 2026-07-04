import { NextResponse } from 'next/server'
import { unlockPeriod } from '@/lib/core/bookkeeping/period-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const POST = withRouteContext(
  'period.unlock',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const period = await unlockPeriod(supabase, companyId!, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      opLog.error('failed to unlock period', err as Error)
      // unlockPeriod() throws plain Error with messages like "Fiscal period not
      // found", "Cannot unlock a closed period" or "Period is not locked":
      // translate to envelope codes, mirroring the sibling lock route.
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (/closed/i.test(message)) {
        return errorResponseFromCode('PERIOD_UNLOCK_CLOSED', opLog, { requestId })
      }
      if (/not locked/i.test(message)) {
        return errorResponseFromCode('PERIOD_UNLOCK_NOT_LOCKED', opLog, { requestId })
      }
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)
