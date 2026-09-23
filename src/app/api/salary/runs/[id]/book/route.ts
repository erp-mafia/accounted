import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { bookPaidSalaryRun } from '@/lib/salary/book-run'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/** paid → booked (creates immutable journal entries). The booking core lives
 * in lib/salary/book-run.ts, shared with the book_salary_run pending-operation
 * executor (MCP gnubok_book_salary_run). */
export const POST = withRouteContext(
  'salary_run.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ salaryRunId: id })

    try {
      const result = await bookPaidSalaryRun(supabase, {
        companyId: companyId!,
        userId: user.id,
        salaryRunId: id,
        log: opLog,
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
      opLog.error('salary booking failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_BOOK_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
