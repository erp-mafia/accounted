import { NextResponse } from 'next/server'
import {
  validateYearEndReadiness,
  previewYearEndClosing,
  executeYearEndClosing,
} from '@/lib/core/bookkeeping/year-end-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** GET: validate readiness + preview the year-end entries. */
export const GET = withRouteContext(
  'period.year_end_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const [validation, preview] = await Promise.all([
        validateYearEndReadiness(supabase, companyId!, user.id, id),
        previewYearEndClosing(supabase, companyId!, user.id, id),
      ])
      return NextResponse.json({ data: { validation, preview } })
    } catch (err) {
      opLog.error('year-end preview failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', opLog, { requestId })
    }
  },
)

/** POST: actually run year-end closing. */
export const POST = withRouteContext(
  'period.year_end',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const result = await executeYearEndClosing(supabase, companyId!, user.id, id)
      return NextResponse.json({ data: result })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      // The downstream errors below are matched on stable English keywords
      // emitted by year-end-service. Do NOT include the raw message in
      // details: it may contain DB-sourced names; UI surfacing relies on
      // the structured message_sv / message_en pair.
      if (/Next fiscal period already has opening balance/i.test(message)) {
        return errorResponseFromCode('YEAR_END_NEXT_PERIOD_HAS_IB', opLog, { requestId })
      }
      if (/No result accounts to close: period has no activity/i.test(message)) {
        return errorResponseFromCode('YEAR_END_NO_ACTIVITY', opLog, {
          requestId,
          reason: 'year-end blocked because the period has no posted result activity',
        })
      }
      if (/prior.*open/i.test(message)) {
        return errorResponseFromCode('YEAR_END_PRIOR_PERIOD_OPEN', opLog, { requestId })
      }
      if (/not balanced|unbalanced/i.test(message)) {
        return errorResponseFromCode('YEAR_END_UNBALANCED_TRIAL', opLog, { requestId })
      }
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      // Unknown failures stay 5xx and retain the original Error object and
      // stack in the log. Expected domain outcomes above are structured 4xx
      // warnings, so Vercel runtime-error clusters remain actionable.
      return errorResponse(err, opLog, { requestId })
    }
  },
  { requireWrite: true },
)
