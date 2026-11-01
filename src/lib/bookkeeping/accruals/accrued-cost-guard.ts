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
 *
 * The customer-invoice mirror (#62) is the upplupen intäkt (17xx): revenue
 * of months before the invoice month (September consulting on an October
 * invoice), each month booked on its last day (Dr 17xx / Cr revenue, no
 * moms) right after the invoice's revenue entry (Dr 1510 / Cr 17xx net +
 * Cr 26xx on the invoice date). assertAccruedIncomeLinesBookable holds the
 * same two rules, called from buildInvoiceJournalEntryInput, so every door
 * that books a customer invoice (issue, send, bulk, the deferred Bokför and
 * its dry run) refuses before anything is written.
 *
 * Both also refuse the opposite mistake (accounted#113): a deferral (a cost
 * on 17xx, revenue on 29xx) of a period that ends before the invoice month.
 * A deferral releases from the invoice date on, so every one of those past
 * months would book on the invoice date; they are upplupna instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  AccruedCostPeriodInvalidError,
  AccruedCostPeriodLockedError,
  AccruedIncomePeriodInvalidError,
  AccruedIncomePeriodLockedError,
  DeferralPeriodPastError,
  type AccruedCostBlockReason,
  type AccruedCostBlockedDate,
} from '@/lib/bookkeeping/errors'
import {
  isAccruedCostAccount,
  isAccruedIncomeAccount,
  itemHasAccrual,
  pastPeriodDeferralSuggestion,
  periodEndsBeforeInvoiceMonth,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import type { AccrualDirection } from '@/types'
import { accruedCostReleaseDates } from '@/lib/bookkeeping/accruals/compute'

interface AccruedCostLine {
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
  /** A supplier invoice line's cost account: picks 2960 over 2990 for 84xx. */
  account_number?: string | null
}

/**
 * Throws DeferralPeriodPastError for the first line that defers a period
 * ending before the invoice month (pastPeriodDeferralSuggestion names the
 * upplupen account it needs). Pure: no reads.
 */
function assertNoPastPeriodDeferral(
  direction: AccrualDirection,
  invoiceDate: string,
  items: ReadonlyArray<AccruedCostLine>,
): void {
  for (const item of items) {
    if (!itemHasAccrual(item)) continue
    const suggested = pastPeriodDeferralSuggestion(
      { direction, targetAccount: item.account_number },
      item.accrual_balance_account,
      item.accrual_period_end,
      invoiceDate,
    )
    if (suggested) {
      throw new DeferralPeriodPastError(
        direction,
        item.accrual_period_start as string,
        item.accrual_period_end as string,
        invoiceDate,
        item.accrual_balance_account ?? null,
        suggested,
      )
    }
  }
}

/**
 * The month-ends of `lines` that cannot take an entry, with the reason:
 * closed or locked, on or before the company lock date, or no fiscal year.
 */
async function blockedMonthEnds(
  supabase: SupabaseClient,
  companyId: string,
  lines: ReadonlyArray<AccruedCostLine>,
): Promise<AccruedCostBlockedDate[]> {
  const dates = [
    ...new Set(
      lines.flatMap((item) =>
        accruedCostReleaseDates(item.accrual_period_start as string, item.accrual_period_end as string),
      ),
    ),
  ].sort()

  const verdicts = await Promise.all(
    dates.map(async (date) => ({ date, verdict: await checkPeriodLock(supabase, companyId, date) })),
  )
  return verdicts.flatMap(({ date, verdict }) => {
    // checkPeriodLock answers "open" for a date no fiscal year covers (the
    // engine may create one for an ad-hoc date); the release posting service
    // never does, so a missing year blocks an upplupen post too.
    if (!verdict.locked && verdict.reason !== 'no_fiscal_period') return []
    const reason: AccruedCostBlockReason = verdict.reason ?? 'lookup_failed'
    return [{ date, reason }]
  })
}

/**
 * Throws AccruedCostPeriodInvalidError or AccruedCostPeriodLockedError when a
 * 29xx line cannot be booked as an upplupen kostnad, and
 * DeferralPeriodPastError for a 17xx line whose period ends before the
 * invoice month; a no-op (and no reads) when no line is a 29xx one.
 */
export async function assertAccruedCostLinesBookable(
  supabase: SupabaseClient,
  companyId: string,
  invoiceDate: string,
  items: ReadonlyArray<AccruedCostLine>,
): Promise<void> {
  assertNoPastPeriodDeferral('expense', invoiceDate, items)
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

  const blocked = await blockedMonthEnds(supabase, companyId, accrued)
  if (blocked.length > 0) throw new AccruedCostPeriodLockedError(blocked)
}

/**
 * Throws AccruedIncomePeriodInvalidError or AccruedIncomePeriodLockedError
 * when a 17xx line cannot be booked as an upplupen intäkt, and
 * DeferralPeriodPastError for a 29xx line whose period ends before the
 * invoice month; a no-op (and no reads) when no line is a 17xx one. Text and
 * ROT/RUT rows never carry a periodisering (the invoice schema refuses it),
 * so every 17xx line here is one the schedule service will post.
 */
export async function assertAccruedIncomeLinesBookable(
  supabase: SupabaseClient,
  companyId: string,
  invoiceDate: string,
  items: ReadonlyArray<AccruedCostLine>,
): Promise<void> {
  assertNoPastPeriodDeferral('revenue', invoiceDate, items)
  const accrued = items.filter(
    (item) => itemHasAccrual(item) && isAccruedIncomeAccount(item.accrual_balance_account),
  )
  if (accrued.length === 0) return

  for (const item of accrued) {
    const start = item.accrual_period_start as string
    const end = item.accrual_period_end as string
    if (!periodEndsBeforeInvoiceMonth(end, invoiceDate)) {
      throw new AccruedIncomePeriodInvalidError(start, end, invoiceDate)
    }
  }

  const blocked = await blockedMonthEnds(supabase, companyId, accrued)
  if (blocked.length > 0) throw new AccruedIncomePeriodLockedError(blocked)
}
