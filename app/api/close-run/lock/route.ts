import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CloseRunLockSchema } from '@/lib/api/schemas'
import { createServiceClient } from '@/lib/supabase/server'
import { buildMonthEndReadinessReport, stageMonthLock } from '@/lib/close-run'

/**
 * POST /api/close-run/lock: stage the month lock as a HIGH-risk pending
 * operation (the granskningskö's terminal step). Staging is allowed even
 * with open blockers: approval is the human gate and the executor re-runs
 * the unbooked hard gate at commit time. The response carries the current
 * readiness report so the UI can show what still blocks.
 */
export const POST = withRouteContext(
  'close-run.lock',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, CloseRunLockSchema)
    if (!validation.success) return validation.response
    const { month } = validation.data

    const report = await buildMonthEndReadinessReport(supabase, companyId, month)
    if (report.alreadyLocked) {
      return NextResponse.json(
        { error: { code: 'ALREADY_LOCKED', message: `Månaden är redan låst t.o.m. ${report.lockedThrough}.` } },
        { status: 409 },
      )
    }

    const staged = await stageMonthLock(createServiceClient(), {
      companyId,
      userId: user.id,
      month,
    })

    return NextResponse.json({ data: { ...staged, report } })
  },
  { requireWrite: true },
)
