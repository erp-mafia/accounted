import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildBokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'

/**
 * GET: aggregated bokslut readiness report: combines validateYearEndReadiness
 * (legal blockers) with bank-reconciliation status and informational reminders
 * for the bokslutsdispositioner that are still booked manually until Phase 2+
 * ships their calculators. One fetch backs the wizard's preflight step.
 */
export const GET = withRouteContext(
  'period.bokslut_readiness',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const report = await buildBokslutReadinessReport(supabase, companyId, user.id, id)
      return NextResponse.json({ data: report })
    } catch (err) {
      opLog.error('bokslut readiness aggregation failed', err as Error)
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      return errorResponseFromCode('YEAR_END_PREVIEW_FAILED', opLog, {
        requestId,
        details: { reason: message },
      })
    }
  },
)
