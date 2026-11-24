import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import type { ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { TargetPeriodClosedError, TargetPeriodLockedError } from '@/lib/bookkeeping/errors'

/**
 * The storno target check's lock refusals (assertStornoTarget) in v1's
 * documented PERIOD_LOCKED shape: details.reason from checkPeriodLock (the
 * layer that locked the date), the original's fiscal_period_id and the
 * refused date under `dateField` (/reverse names it reversal_date, /correct
 * entry_date). Null for any other error.
 */
export async function stornoTargetLockedResponse(
  ctx: ApiV1Context,
  err: unknown,
  fiscalPeriodId: string,
  dateField: 'reversal_date' | 'entry_date',
) {
  if (!(err instanceof TargetPeriodClosedError) && !(err instanceof TargetPeriodLockedError)) return null
  const verdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, err.date)
  const fallback = err instanceof TargetPeriodClosedError ? 'period_is_closed' : 'period_locked_at_set'
  return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
    requestId: ctx.requestId,
    details: {
      reason: verdict.locked ? verdict.reason : fallback,
      fiscal_period_id: fiscalPeriodId,
      [dateField]: err.date,
    },
  })
}
