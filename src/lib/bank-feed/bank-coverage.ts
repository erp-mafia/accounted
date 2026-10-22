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
 */
export const UNCOVERED_BANK_NEEDLES: readonly string[] = ['wise', 'paypal', 'norwegian', 'first card', 'juni']

/** Whether Open Payments reaches this bank (every bank not on the uncovered list counts as covered). */
export function bankCoveredByOpenPayments(bankName: string | null | undefined): boolean {
  const name = (bankName ?? '').trim().toLowerCase()
  if (!name) return true
  return !UNCOVERED_BANK_NEEDLES.some((needle) => name.includes(needle))
}

/**
 * The banks the Enable Banking "Anslut ny bank" list offers a new connection
 * to: all of them while Open Payments is closed to the company; once it is
 * open, only the banks it does not reach, since a bank it reaches is
 * connected through its Koppla bank (crm#1363). Undefined offers every bank.
 */
export function enableBankingOffers(openPaymentsAvailable: boolean): ((bank: { name: string }) => boolean) | undefined {
  return openPaymentsAvailable ? (bank) => !bankCoveredByOpenPayments(bank.name) : undefined
}
