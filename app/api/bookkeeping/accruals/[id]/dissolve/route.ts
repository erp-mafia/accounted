import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { dissolveScheduleNow } from '@/lib/bookkeeping/accruals/service'
import {
  ACCRUAL_NOTHING_TO_DISSOLVE,
  ACCRUAL_SCHEDULE_NOT_ACTIVE,
  ACCRUAL_SCHEDULE_NOT_FOUND,
  isAccrualError,
} from '@/lib/bookkeeping/accruals/errors'

ensureInitialized()

/**
 * POST /api/bookkeeping/accruals/[id]/dissolve
 *
 * "Lös upp nu": books the schedule's remaining months in ONE verifikat dated
 * today (clamped by lock date) and completes the schedule. Used when the
 * underlying service ends early or the user wants the rest expensed now.
 * Cancelling-with-storno only happens via the credit flows: a standalone
 * cancel would strand the interim-account balance.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'accruals.dissolve',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    try {
      const result = await dissolveScheduleNow(supabase, companyId!, user.id, id)
      // Manual financial write: log the acting user for auditability.
      log.info('accrual schedule dissolved', {
        userId: user.id,
        companyId,
        scheduleId: id,
        amount: result.amount,
        journalEntryId: result.journalEntryId,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown'
      // Typed domain errors carry a stable code: never match Swedish prose.
      if (isAccrualError(err)) {
        switch (err.code) {
          case ACCRUAL_SCHEDULE_NOT_FOUND:
            return errorResponseFromCode('ACCRUAL_NOT_FOUND', log, { requestId })
          case ACCRUAL_SCHEDULE_NOT_ACTIVE:
            return errorResponseFromCode('ACCRUAL_NOT_ACTIVE', log, {
              requestId,
              details: { currentStatus: err.currentStatus },
            })
          case ACCRUAL_NOTHING_TO_DISSOLVE:
            return errorResponseFromCode('ACCRUAL_NOTHING_TO_DISSOLVE', log, { requestId })
        }
      }
      log.error('accrual dissolve failed', err as Error, { entityId: id })
      return errorResponseFromCode('ACCRUAL_DISSOLVE_FAILED', log, {
        requestId,
        details: { reason },
      })
    }
  },
  { requireWrite: true },
)
