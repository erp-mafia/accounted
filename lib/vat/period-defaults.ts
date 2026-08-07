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

export interface VatPeriodDefault {
  year: number
  /** 1-12 for monthly, 1-4 for quarterly. */
  period: number
}

export function mostRecentEndedVatPeriod(
  periodType: 'monthly' | 'quarterly',
  today: Date = new Date(),
  opts: { over40m?: boolean } = {},
): VatPeriodDefault {
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  if (periodType === 'monthly') {
    let m = month - 1
    let y = year
    if (!opts.over40m) {
      // Deadline day of the CURRENT month for the M-2 declaration: 17 in
      // January and August, else 12 (deadline-config huvudregel).
      const deadlineDay = month === 1 || month === 8 ? 17 : 12
      if (today.getDate() <= deadlineDay) m -= 1
    }
    while (m < 1) {
      m += 12
      y -= 1
    }
    return { year: y, period: m }
  }

  const quarter = Math.ceil(month / 3)
  return quarter === 1 ? { year: year - 1, period: 4 } : { year, period: quarter - 1 }
}
