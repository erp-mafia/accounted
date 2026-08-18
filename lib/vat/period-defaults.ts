/**
 * Default period selection for the VAT declaration view.
 *
 * A momsdeklaration can only ever be filed for a period that has ENDED, so
 * the view defaults to the most recently ended month/quarter instead of the
 * current one (which used to force a step-back click on every filing visit,
 * and invited reading rutor for a period that cannot be filed yet).
 *
 * Monthly filers below the 40 MSEK threshold declare month M on the 12th of
 * M+2 (17th when that deadline lands in January or August), mirroring
 * lib/tax/deadline-config.ts. Until that deadline has passed, the declaration
 * the user actually has open is M-2, not M-1, so the default tracks the
 * deadline. Over-40M companies declare M on the 26th of M+1, which makes the
 * most recently ended month the due one year-round.
 */

import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'

export interface VatPeriodDefault {
  year: number
  /** 1-12 for monthly, 1-4 for quarterly. */
  period: number
}

/** Return the monthly VAT period a fixed number of months before a month. */
function previousMonth(year: number, month: number, monthsBack: number): VatPeriodDefault {
  const date = new Date(year, month - 1 - monthsBack, 1)
  return { year: date.getFullYear(), period: date.getMonth() + 1 }
}

/** Select the latest ended VAT period that is currently relevant for filing. */
export function mostRecentEndedVatPeriod(
  periodType: 'monthly' | 'quarterly',
  today: Date = new Date(),
  opts: { over40m?: boolean } = {},
): VatPeriodDefault {
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  if (periodType === 'monthly') {
    const mostRecentEnded = previousMonth(year, month, 1)
    if (opts.over40m) return mostRecentEnded

    const periodDueThisMonth = previousMonth(year, month, 2)
    const deadline = getVatDeadlineForPeriod(
      'monthly',
      periodDueThisMonth.year,
      periodDueThisMonth.period,
      { vat_taxable_base_over_40m: false },
    )
    const adjustedDeadline = deadline
      ? adjustDeadlineToNextBankingDay(new Date(deadline.year, deadline.month, deadline.day))
      : null
    const currentDate = new Date(year, month - 1, today.getDate())
    return adjustedDeadline && currentDate <= adjustedDeadline
      ? periodDueThisMonth
      : mostRecentEnded
  }

  const quarter = Math.ceil(month / 3)
  return quarter === 1 ? { year: year - 1, period: 4 } : { year, period: quarter - 1 }
}
