import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { accrualSchedulesCancel } from '@/lib/operations/accrual-schedules'
import { sessionFailureResponse } from '@/lib/operations/session'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const CancelBodySchema = z.object({ dry_run: z.boolean().optional() })

/**
 * POST /api/bookkeeping/accruals/[id]/cancel
 *
 * "Ångra periodisering" on a periodisering set up by hand: its months not yet
 * posted are cancelled and the months it posted stornoed, so the amount is
 * back on the balance account. { dry_run: true } lists the months and writes
 * nothing. An invoice's plan is refused (credit the invoice). The rules live
 * in cancelManualSchedule, the same service the v1 endpoint and
 * gnubok_cancel_accrual_schedule run (operation accrual-schedules.cancel).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'accruals.cancel',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CancelBodySchema)
    if (!validation.success) return validation.response
    // A malformed id names no schedule.
    const parsedId = z.string().uuid().safeParse(id)
    if (!parsedId.success) return errorResponseFromCode('ACCRUAL_NOT_FOUND', log, { requestId })
    const outcome = await accrualSchedulesCancel.run(
      { supabase, companyId, userId: user.id, log },
      { accrual_schedule_id: parsedId.data },
      { dryRun: validation.data.dry_run === true },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    // Manual financial write: log the acting user for auditability.
    log.info('manual accrual schedule cancelled', { userId: user.id, companyId, scheduleId: parsedId.data })
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true },
)
