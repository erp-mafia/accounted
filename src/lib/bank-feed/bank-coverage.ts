/**
 * Which banks Open Payments reaches, by the Enable Banking bank name.
 * Dependency-free on purpose (like ./bank-match and ./switch-link): the
 * switch campaign decides server-side with it which rows count as uncovered,
 * and the settings rows decide in the browser, once the old feed has ended,
 * whether a row offers the switch or the file import. One list, so the two
 * can never disagree.
 */

/**
 * Banks Open Payments does not reach at all, as substrings of the Enable
 * Banking bank name (lower-cased). Checked BEFORE the name match against the
 * Open Payments list: "Nordea First Card" would otherwise match "Nordea".
 * The SQL counter (bank_switch_progress) takes this same list as its
 * argument, so it is defined once.
 *
 * Svea is on it for now (2026-10-15): Open Payments lists it, but refuses
 * its second consent, the one naming the chosen accounts, with 400
 * UNEXPECTED_ERROR (raised with their support). Until a Svea consent goes
 * through, its rows keep Enable Banking and the new flow points there.
 */
export const UNCOVERED_BANK_NEEDLES: readonly string[] = ['wise', 'paypal', 'norwegian', 'first card', 'juni', 'svea']

/** Whether Open Payments reaches this bank (every bank not on the uncovered list counts as covered). */
export function bankCoveredByOpenPayments(bankName: string | null | undefined): boolean {
  const name = (bankName ?? '').trim().toLowerCase()
  if (!name) return true
  return !UNCOVERED_BANK_NEEDLES.some((needle) => name.includes(needle))
}
