import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { replanRemainingInstallments } from '@/lib/bookkeeping/accruals/service'
import {
  REPLAN_NEEDS_A_CHANGE,
  ReplanAccrualFields,
  replanChangesSomething,
} from '@/lib/operations/accrual-schedules'
import { sessionFailureResponse } from '@/lib/operations/session'

const ReplanAccrualBodySchema = ReplanAccrualFields.extend({
  dry_run: z.boolean().optional(),
}).refine(replanChangesSomething, REPLAN_NEEDS_A_CHANGE)

/**
 * PATCH /api/bookkeeping/accruals/[id]
 *
 * "Ändra periodisering": re-plan the months not yet posted with a new
 * period end and/or the day each month books on. { dry_run: true } answers
 * the months before and after and writes nothing; the dialog shows it
 * before the user confirms. The rules live in replanRemainingInstallments,
 * the same service the v1 endpoint and gnubok_replan_accrual_schedule run
 * (operation accrual-schedules.replan).
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'accruals.replan',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, ReplanAccrualBodySchema)
    if (!validation.success) return validation.response
    const { dry_run: dryRun, period_end, release_day } = validation.data

    const outcome = await replanRemainingInstallments(
      { supabase, companyId, userId: user.id, log },
      id,
      {
        ...(period_end !== undefined ? { periodEnd: period_end } : {}),
        ...(release_day !== undefined ? { releaseDay: release_day } : {}),
      },
      { dryRun: dryRun === true },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    // Manual change to future postings: log the acting user for auditability.
    log.info('accrual schedule re-planned', { userId: user.id, companyId, scheduleId: id })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
