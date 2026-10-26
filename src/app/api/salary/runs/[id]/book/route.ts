import { NextResponse } from 'next/server'
import { bookPaidSalaryRun } from '@/lib/salary/book-run'
import { SalaryRunPartiallyBookedError } from '@/lib/salary/salary-entries'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/** paid → booked (creates immutable journal entries). The booking core lives
 * in lib/salary/book-run.ts, shared with the v1 :book verb and the
 * book_salary_run pending-operation executor (MCP gnubok_book_salary_run).
 * The optional body { confirm_payment_date_ahead: true } is the Bokför
 * dialog's confirmation when the payment date has not come yet; without it
 * such a run is refused (crm#1216). */
export const POST = withRouteContext(
  'salary_run.book',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { confirm_payment_date_ahead?: unknown } | null
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ salaryRunId: id })

    try {
      const result = await bookPaidSalaryRun(supabase, {
        companyId: companyId!,
        userId: user.id,
        salaryRunId: id,
        log: opLog,
        confirmPaymentDateAhead: body?.confirm_payment_date_ahead === true,
      })

      if (!result.ok) {
        if (result.dbError) {
          return errorResponse(result.dbError, opLog, { requestId })
        }
        return errorResponseFromCode(result.code, opLog, { requestId, details: result.details })
      }

      return NextResponse.json({ data: result.data.run })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      // Posted vouchers of the run that this booking would not post: the
      // message names them, so the user knows which ones to reverse.
      if (err instanceof SalaryRunPartiallyBookedError) {
        return errorResponseFromCode(err.code, opLog, {
          requestId,
          details: err.details,
          messageSv: err.message,
          messageEn: err.messageEn,
        })
      }
      opLog.error('salary booking failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_BOOK_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
