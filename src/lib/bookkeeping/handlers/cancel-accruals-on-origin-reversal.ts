import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { cancelManualSchedulesForOrigin } from '@/lib/bookkeeping/accruals/manual'
import { createLogger } from '@/lib/logger'
import type { EventPayload } from '@/lib/events/types'

const log = createLogger('bookkeeping.accruals.origin-reversal')

/**
 * A reversed verifikat takes its manual periodiseringar with it (accounted#164):
 * the storno took the amount off the 17xx/29xx account, so the plans that
 * spread it are cancelled and the months they posted stornoed, as crediting
 * an invoice cancels the invoice's plans. A storno and rättelse
 * (correctEntry, journal_entry.corrected) keeps its plans: the rättelse
 * stands in for the origin.
 *
 * Runs on journal_entry.reversed through EVENT_CONSUMERS
 * (lib/composition/event-consumers.ts). A failure throws to the event bus,
 * which logs it as an error; the posting run then still books no month of a
 * plan whose origin is gone (manualOriginStands in
 * lib/bookkeeping/accruals/service.ts). Months that could not be stornoed are
 * logged as an error here for the same reason: nobody is told otherwise.
 */
export async function cancelAccrualsOnOriginReversal({
  originalEntry,
  reversalEntry,
  userId,
  companyId,
}: EventPayload<'journal_entry.reversed'>): Promise<void> {
  // A dissolution's or a storno's own reversal is never a manual plan's origin.
  if (originalEntry.source_type === 'accrual' || originalEntry.source_type === 'storno') return
  const result = await cancelManualSchedulesForOrigin(
    createServiceClientNoCookies(),
    companyId,
    userId,
    originalEntry.id,
    { reversalDate: reversalEntry.entry_date },
  )
  if (result.failedReversals > 0) {
    // An error, not a warning: this consumer runs once per reversal and
    // nothing retries it, so a month left standing here stays on the interim
    // account until a person undoes the plan. The plan stays active with the
    // reason on its months (cancelSchedules), which is what the user sees.
    log.error(
      'manual accrual months could not be reversed with their origin',
      new Error('accrual months left standing after their origin was reversed'),
      {
        companyId,
        originEntryId: originalEntry.id,
        failedReversals: result.failedReversals,
      },
    )
  }
}
