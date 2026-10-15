/**
 * Upplupna kostnader (29xx) on supplier invoice lines: what has to hold before
 * the registration verifikat is posted.
 *
 * A 29xx line is the cost of months before the invoice month (September
 * electricity on an October invoice). Each month's share books on that
 * month's last day (Dr cost / Cr 29xx, no moms) right after the registration
 * commits (Dr 29xx net + Dr 2641 / Cr 2440 on the invoice date). Two things
 * would break that, and both are refused before anything is written:
 *
 *   - a period that reaches the invoice month: the invoice month's own cost
 *     is not accrued, so the line has to be split;
 *   - a month-end that cannot take an entry (closed or locked period, on or
 *     before the company lock date, no fiscal year). The cost belongs to that
 *     month, so it is never moved to another one, unlike a 17xx release,
 *     which the posting service clamps forward.
 *
 * buildSupplierInvoiceRegistrationEntryInput calls this, so every door that
 * books a registration (dashboard and v1 create, inbox convert, the deferred
 * Bokför and its dry run) is held to it. The DB triggers stay authoritative;
 * this answers the caller before a 29xx debit could land without its cost.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  AccruedCostPeriodInvalidError,
  AccruedCostPeriodLockedError,
  type AccruedCostBlockReason,
  type AccruedCostBlockedDate,
} from '@/lib/bookkeeping/errors'
import {
  isAccruedCostAccount,
  itemHasAccrual,
  periodEndsBeforeInvoiceMonth,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import { accruedCostReleaseDates } from '@/lib/bookkeeping/accruals/compute'

interface AccruedCostLine {
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
}

/**
 * Throws AccruedCostPeriodInvalidError or AccruedCostPeriodLockedError when a
 * 29xx line cannot be booked as an upplupen kostnad; a no-op (and no reads)
 * when no line is one.
 */
export async function assertAccruedCostLinesBookable(
  supabase: SupabaseClient,
  companyId: string,
  invoiceDate: string,
  items: ReadonlyArray<AccruedCostLine>,
): Promise<void> {
  const accrued = items.filter(
    (item) => itemHasAccrual(item) && isAccruedCostAccount(item.accrual_balance_account),
  )
  if (accrued.length === 0) return

  for (const item of accrued) {
    const start = item.accrual_period_start as string
    const end = item.accrual_period_end as string
    if (!periodEndsBeforeInvoiceMonth(end, invoiceDate)) {
      throw new AccruedCostPeriodInvalidError(start, end, invoiceDate)
    }
  }

  const dates = [
    ...new Set(
      accrued.flatMap((item) =>
        accruedCostReleaseDates(item.accrual_period_start as string, item.accrual_period_end as string),
      ),
    ),
  ].sort()

  const verdicts = await Promise.all(
    dates.map(async (date) => ({ date, verdict: await checkPeriodLock(supabase, companyId, date) })),
  )
  const blocked: AccruedCostBlockedDate[] = verdicts.flatMap(({ date, verdict }) => {
    // checkPeriodLock answers "open" for a date no fiscal year covers (the
    // engine may create one for an ad-hoc date); the release posting service
    // never does, so a missing year blocks an upplupen kostnad too.
    if (!verdict.locked && verdict.reason !== 'no_fiscal_period') return []
    const reason: AccruedCostBlockReason = verdict.reason ?? 'lookup_failed'
    return [{ date, reason }]
  })
  if (blocked.length > 0) throw new AccruedCostPeriodLockedError(blocked)
}
