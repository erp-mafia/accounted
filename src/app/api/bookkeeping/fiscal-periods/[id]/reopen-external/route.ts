import { NextResponse } from 'next/server'
import { reopenExternallyClosedPeriod } from '@/lib/core/bookkeeping/period-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

// Undo "klarmarkera": reopen a period that was marked as closed in a previous
// bookkeeping system. Structured envelope like the sibling lock/unlock routes
// (FiscalYearsManager surfaces error.message verbatim).
export const POST = withRouteContext(
  'period.reopen_external',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const period = await reopenExternallyClosedPeriod(supabase, companyId!, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      opLog.error('failed to reopen externally closed period', err as Error)
      // reopenExternallyClosedPeriod() throws plain Error: "Fiscal period not
      // found", "Period is not closed", "Period was closed with a year-end
      // run ...". Translate to envelope codes, mirroring the unlock route.
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (/not closed/i.test(message)) {
        return errorResponseFromCode('PERIOD_REOPEN_NOT_CLOSED', opLog, { requestId })
      }
      if (/year-end run/i.test(message)) {
        return errorResponseFromCode('PERIOD_REOPEN_NOT_EXTERNAL', opLog, { requestId })
      }
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)
