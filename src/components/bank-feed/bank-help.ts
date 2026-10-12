/**
 * What to expect at each bank before the BankID starts: the generic line
 * ("Så går det till hos {bank}: BankID, välj företag, godkänn åtkomst") plus
 * the one thing we know about the known banks. Keyed by the bank's name as
 * the provider lists it; the texts live in messages/ under bank_connect.help_*.
 *
 * Two kinds: a PREREQUISITE (Handelsbanken's third-party access, Nordea's
 * business user, Swedbank's "välj företaget") prevents a failed BankID and
 * stays visible as the step's one attention line; a PROCESS note (Svea's two
 * rounds) is help, behind the "?".
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

const PREREQUISITES: ReadonlySet<BankHelpKey> = new Set(['handelsbanken', 'nordea', 'swedbank'])

/** The help text to show for a bank, or null when we know of none. */
export function bankHelpKey(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): BankHelpKey | null {
  for (const [pattern, key] of HELP_PATTERNS) {
    if (pattern.test(bank.name)) return key
  }
  if (/^SVEASESS/i.test(bank.bic)) return 'svea'
  return null
}

/** The prerequisite that prevents a failed BankID at this bank (shown as the step's attention line), or null. */
export function bankPrerequisiteKey(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): BankHelpKey | null {
  const key = bankHelpKey(bank)
  return key && PREREQUISITES.has(key) ? key : null
}

/** Svea runs the consent in two BankID rounds: accounts first, then a confirmation of the chosen ones. */
export function isTwoStepBank(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): boolean {
  return bankHelpKey(bank) === 'svea'
}

/** A bank that only signs on its own page cannot be connected from this flow yet. */
export function bankSelectable(bank: Pick<OpenPaymentsBank, 'decoupled'>): boolean {
  return bank.decoupled !== false
}

/**
 * Per-bank walkthrough films, keyed by BIC. Empty until the provider's
 * per-bank videos are in hand; nothing renders for a bank without one.
 */
export const BANK_GUIDE_URLS: Readonly<Record<string, string>> = {}

/** The film for this bank, or null. */
export function bankGuideUrl(bank: Pick<OpenPaymentsBank, 'bic'>, urls: Readonly<Record<string, string>> = BANK_GUIDE_URLS): string | null {
  return urls[bank.bic.toUpperCase()] ?? null
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
