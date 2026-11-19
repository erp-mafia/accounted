/**
 * Which fiscal period the opening-balance wizard preselects.
 */

/** The fields the choice depends on. Widened so the hook's row type fits. */
export interface SelectableFiscalPeriod {
  id: string
  is_closed?: boolean | null
  locked_at?: string | null
  opening_balances_set?: boolean | null
}

/** A period the wizard is allowed to write an opening balance into. */
function isWritable(period: SelectableFiscalPeriod): boolean {
  return !period.is_closed && !period.locked_at
}

/**
 * Preselect a period for the opening-balance step.
 *
 * Prefers a writable period that has no opening balance yet: a first import
 * lands straight on "Bokför". When every writable period already has one, it
 * falls back to the first of them, because replacing an opening balance is
 * reachable only from a selected period that has one.
 *
 * A closed or locked period is never preselected: it cannot be written either
 * way.
 */
export function pickDefaultOpeningBalancePeriod<T extends SelectableFiscalPeriod>(
  periods: readonly T[],
): T | undefined {
  const writable = periods.filter(isWritable)
  return writable.find((p) => !p.opening_balances_set) ?? writable[0]
}
