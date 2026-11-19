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
  // Swedbank, the sparbanker and Ölands Bank share one login and one "välj företag" prompt.
  [/swedbank|sparbank|ölands bank/i, 'swedbank'],
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

/**
 * Banks that take no request for the bank itself: one of the offices in its
 * details (the affiliates) must be chosen, and a start without one is refused
 * over the X-AffiliatedASPSP-ID header. Keyed by the BIC the provider lists.
 * Swedbank (SWEDSESS) is not one: the bank behind its shared BIC is itself a
 * bank a company has accounts in.
 */
const OFFICE_REQUIRED_BICS: ReadonlySet<string> = new Set(['RESUSE2H'])

/** The bank needs one of its offices chosen, so its own row is not offered in the picker (for #158). */
export function bankRequiresOffice(bank: Pick<OpenPaymentsBank, 'bic'>): boolean {
  return OFFICE_REQUIRED_BICS.has(bank.bic.trim().toUpperCase().slice(0, 8))
}

/** Svea runs the consent in two BankID rounds: accounts first, then a confirmation of the chosen ones. */
export function isTwoStepBank(bank: Pick<OpenPaymentsBank, 'name' | 'bic'>): boolean {
  return bankHelpKey(bank) === 'svea'
}

/**
 * How a person signs at a bank: in our screen (decoupled: an animated QR or
 * the BankID app on this device), on the bank's own page (redirect: the
 * browser goes there and comes back), both, or neither we can do. The list
 * answers with nulls for a bank it does not know about; null counts as our
 * screen until the bank's details say otherwise.
 */
export type SigningApproach = 'decoupled' | 'redirect' | 'both' | 'none'

export function bankSigningApproach(bank: Pick<OpenPaymentsBank, 'decoupled' | 'redirect'>): SigningApproach {
  const decoupled = bank.decoupled !== false
  const redirect = bank.redirect === true
  if (decoupled && redirect) return 'both'
  if (decoupled) return 'decoupled'
  return redirect ? 'redirect' : 'none'
}

/** A bank we can sign at one way or the other can be chosen. */
export function bankSelectable(bank: Pick<OpenPaymentsBank, 'decoupled' | 'redirect'>): boolean {
  return bankSigningApproach(bank) !== 'none'
}

/**
 * The list entry for a connection row's bank, which names the bank but not
 * its BIC: the same name, a name containing the other, and for a sparbank or
 * Ölands Bank the Swedbank entry they are reached through. Null when the list
 * knows no such bank.
 */
export function resolveBankByName<T extends { name: string }>(banks: readonly T[], name: string): T | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  const exact = banks.find((b) => b.name.trim().toLowerCase() === wanted)
  if (exact) return exact
  const partial = banks.find((b) => b.name.toLowerCase().includes(wanted) || wanted.includes(b.name.toLowerCase()))
  if (partial) return partial
  if (/sparbank|ölands bank/i.test(wanted)) return banks.find((b) => /swedbank/i.test(b.name)) ?? null
  return null
}

/**
 * Per-bank guides for the company (what to approve at the bank before
 * BankID), keyed by BIC: Open Payments' own public pages
 * (openpayments.io/integrera, named by their support 2026-10-14). Only
 * some of them carry films, and that is theirs to change, so the link
 * text promises a guide, never films (crm#1686). Nothing renders for a
 * bank without one.
 */
export const BANK_GUIDE_URLS: Readonly<Record<string, string>> = {
  DABASESX: 'https://www.openpayments.io/integrera/danske-bank-psd2',
  DNBASESX: 'https://www.openpayments.io/integrera/dnb-psd2',
  HANDSESS: 'https://www.openpayments.io/integrera/handelsbanken-psd2',
  NDEASESS: 'https://www.openpayments.io/integrera/nordea-psd2',
  ESSESESS: 'https://www.openpayments.io/integrera/seb-psd2',
  SWEDSESS: 'https://www.openpayments.io/integrera/swedbank-psd2',
}

/** The guide page for this bank, or null. */
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
