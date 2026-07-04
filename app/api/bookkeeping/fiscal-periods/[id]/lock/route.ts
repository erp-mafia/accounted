import { NextResponse } from 'next/server'
import { lockPeriod } from '@/lib/core/bookkeeping/period-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

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
      opLog.error('failed to lock period', err as Error)
      // The service throws plain Error with messages like "Period not found"
      // or "Period contains drafts": translate to envelope codes.
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (/already locked|already closed/i.test(message)) {
        return errorResponseFromCode('PERIOD_LOCK_ALREADY_LOCKED', opLog, { requestId })
      }
      if (/draft/i.test(message)) {
        return errorResponseFromCode('PERIOD_LOCK_HAS_DRAFTS', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      // lockPeriod() refuses to lock a period that still has uncategorized
      // business transactions (the count is in the thrown message). Surface it
      // as a clear 400 instead of letting it fall through to a generic 500.
      if (/saknar bokföring|okategoriserade affärstransaktion/i.test(message)) {
        return errorResponseFromCode('PERIOD_HAS_UNBOOKED_TRANSACTIONS', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)
