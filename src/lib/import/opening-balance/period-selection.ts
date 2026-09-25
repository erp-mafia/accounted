/**
 * Which fiscal period the opening-balance wizard preselects.
 *
 * Extracted from OpeningBalancePeriodStep so the rule can be tested: the
 * component's own effect is not in the test scope, and the rule is where the
 * bug was.
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
 * Prefers a writable period that has no opening balance yet, because the first
 * import is the common case and lands straight on "Bokför".
 *
 * Falls back to the first writable period even when it already has one. That
 * fallback is the fix: the wizard used to require `!opening_balances_set`, so
 * a company whose only period already had an IB got nothing preselected, a
 * disabled button, and the label "Bokför ingående balanser" for an action it
 * could not perform. Replacing an IB is supported (storno + rebook + relink),
 * and it is reachable only from a selected period that has one.
 *
 * A closed or locked period is never preselected: it cannot be written either
 * way, and choosing it would replace a usable default with a dead end.
 */
export function pickDefaultOpeningBalancePeriod<T extends SelectableFiscalPeriod>(
  periods: readonly T[],
): T | undefined {
  const writable = periods.filter(isWritable)
  return writable.find((p) => !p.opening_balances_set) ?? writable[0]
}
