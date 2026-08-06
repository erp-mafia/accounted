/**
 * Default period selection for the VAT declaration view.
 *
 * A momsdeklaration can only ever be filed for a period that has ENDED, so
 * the view defaults to the most recently ended month/quarter instead of the
 * current one (which used to force a step-back click on every filing visit,
 * and invited reading rutor for a period that cannot be filed yet).
 */

export interface VatPeriodDefault {
  year: number
  /** 1-12 for monthly, 1-4 for quarterly. */
  period: number
}

export function mostRecentEndedVatPeriod(
  periodType: 'monthly' | 'quarterly',
  today: Date = new Date(),
): VatPeriodDefault {
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  if (periodType === 'monthly') {
    return month === 1 ? { year: year - 1, period: 12 } : { year, period: month - 1 }
  }

  const quarter = Math.ceil(month / 3)
  return quarter === 1 ? { year: year - 1, period: 4 } : { year, period: quarter - 1 }
}
