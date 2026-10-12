/**
 * What to expect at each bank before the BankID starts: the generic line
 * ("Så går det till hos {bank}: BankID, välj företag, godkänn åtkomst") plus
 * the one prerequisite we know trips people at the known banks. Keyed by the
 * bank's name as the provider lists it; the texts live in messages/ under
 * bank_connect.help_*.
 */

import type { OpenPaymentsBank } from './open-payments-client'

export type BankHelpKey = 'handelsbanken' | 'nordea' | 'swedbank' | 'svea'

const HELP_PATTERNS: ReadonlyArray<readonly [RegExp, BankHelpKey]> = [
  [/handelsbanken/i, 'handelsbanken'],
  [/nordea/i, 'nordea'],
  // Swedbank and the sparbanker share one login and one "välj företag" prompt.
  [/swedbank|sparbank/i, 'swedbank'],
  [/\bsvea\b/i, 'svea'],
]

/** The prerequisite sentence to show for a bank, or null when we know of none. */
export function bankHelpKey(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): BankHelpKey | null {
  for (const [pattern, key] of HELP_PATTERNS) {
    if (pattern.test(bank.name)) return key
  }
  if (/^SVEASESS/i.test(bank.bic)) return 'svea'
  return null
}

/** Svea runs the consent in two BankID rounds: accounts first, then a confirmation of the chosen ones. */
export function isTwoStepBank(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): boolean {
  return bankHelpKey(bank) === 'svea'
}

/** A bank that only signs on its own page cannot be connected from this flow yet. */
export function bankSelectable(bank: Pick<OpenPaymentsBank, 'decoupled'>): boolean {
  return bank.decoupled !== false
}

/** The banks most people in Sweden have, listed first when nobody is searching. */
const POPULAR = ['swedbank', 'seb', 'nordea', 'handelsbanken', 'danske', 'länsförsäkringar', 'lansforsakringar']

function popularityRank(name: string): number {
  const lower = name.toLowerCase()
  const index = POPULAR.findIndex((p) => lower.includes(p))
  return index < 0 ? POPULAR.length : index
}

/** Popular banks first, then the rest alphabetically (Swedish collation). */
export function orderBanks<T extends { name: string }>(banks: readonly T[]): T[] {
  return [...banks].sort((a, b) => popularityRank(a.name) - popularityRank(b.name) || a.name.localeCompare(b.name, 'sv'))
}
