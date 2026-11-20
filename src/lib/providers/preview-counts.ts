/**
 * The counts a provider connection's preview shows, and the one rule for
 * when they may be shown as the user's selection.
 *
 * GET /preview (arcim-migration) reads the SIE export of the DEFAULT fiscal
 * years only (the current year and the two before it): every further year is
 * one more export, so older years are read when the user has ticked them and
 * pressed on (GET /sie-data). The account and voucher counts therefore cover
 * exactly the years the preview read, which `fiscalYears` names.
 *
 * crm#1037: the Import page printed those counts as "N konton · M
 * verifikationer · 3 räkenskapsår: 2024, 2025, 2026" above a picker with
 * five years ticked, and the user took it to mean two of them would be left
 * out (all five were imported). The onboarding step showed the same counts
 * beside the source's year count, as if they covered all five years. Both
 * screens now ask this module instead of reading the counts directly.
 *
 * Kept in core so the extension that computes the counts and both screens
 * that show them share one definition (core must not import from
 * @/extensions/, but extensions may import from core).
 */

/** What GET /preview answers as `sieStats`. */
export interface ProviderPreviewCounts {
  /** Accounts in the read exports' charts (#KONTO), by number. */
  accountCount: number
  /** Vouchers in the read exports. */
  transactionCount: number
  /**
   * The fiscal years (start years) the counts were read from: the default
   * years whose export came back. A year whose export failed is not counted,
   * so it is not named here.
   */
  fiscalYears: number[]
}

export interface SelectionCounts {
  accounts: number
  vouchers: number
}

/**
 * The preview's counts when they were read from exactly the selected fiscal
 * years (start years, in any order); null when the selection holds a year the
 * preview did not read, leaves out one it did, or is empty. A null is shown
 * as "counted when the years are fetched": a number read from another set of
 * years is never presented as the selection's.
 */
export function previewCountsForSelection(
  counts: ProviderPreviewCounts | null | undefined,
  selectedYears: readonly number[],
): SelectionCounts | null {
  if (!counts || selectedYears.length === 0) return null
  const read = new Set(counts.fiscalYears)
  const selected = new Set(selectedYears)
  if (read.size !== selected.size) return null
  for (const year of selected) {
    if (!read.has(year)) return null
  }
  return { accounts: counts.accountCount, vouchers: counts.transactionCount }
}
