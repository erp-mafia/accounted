/**
 * Jämkning helpers — input-VAT correction on disposal of investeringsvara
 * within the korrigeringstid (ML 8a kap 4-7 §§).
 *
 * When an asset that had input VAT deducted at acquisition is disposed of
 * within the correction period, part of the original deducted input VAT
 * must be paid back. The amount is the portion that corresponds to the
 * remaining months of the correction period.
 *
 * Correction periods per ML 8a kap 6 §:
 *   - 60 months (5 years) for lös egendom / movable property
 *   - 120 months (10 years) for fastighet / markanläggning (real property)
 *
 * The two functions in this file are PURE (no I/O, no Supabase, no clock
 * read) so they can be tested with simple input/output cases.
 *
 * Caller responsibility:
 *   - Decide whether a disposal event triggers jämkning. The most common
 *     trigger is a sale within korrigeringstid, but ML 8a kap also lists
 *     "ändrad användning" and "utträde ur skattskyldighet". The caller
 *     passes the boolean so this helper stays domain-agnostic.
 *   - Source `originalInputVat`. For new assets this comes from the
 *     supplier invoice that booked the acquisition; for legacy assets the
 *     user has to enter it manually.
 */

import type { AssetCategory } from '@/types'

/**
 * Inputs to compute the jämkning amount on disposal.
 */
export interface JamkningInput {
  /** Original input VAT deducted at acquisition (BAS 2641 debit). */
  originalInputVat: number
  /**
   * Total correction period in months. 60 for movable property,
   * 120 for fastighet / markanläggning. Caller decides which.
   */
  totalCorrectionMonths: number
  /**
   * Months remaining in the correction period as of the disposal date.
   * Caller computes this so the helper avoids any clock / calendar
   * dependency.
   */
  remainingMonths: number
  /**
   * Whether the disposal event triggers jämkning at all. Most disposals
   * within the korrigeringstid trigger it, but the caller may opt out
   * (e.g. the buyer continues to use the asset in a fully taxable
   * verksamhet and assumes the jämkning obligation via avtal — ML 8a kap
   * 12 §).
   */
  disposalEvent: 'triggers_jamkning' | 'no_jamkning'
}

/**
 * Compute the jämkning amount per ML 8a kap 7 §. Returns a positive number
 * representing the amount to be paid back to the state (i.e. reverse the
 * input-VAT deduction). When disposal happens AFTER the correction period
 * (remainingMonths <= 0) the formula returns 0 — caller can simply skip
 * the line.
 *
 * Formula: (remaining / total) × originalInputVat
 *
 * Edge cases:
 *   - disposalEvent = 'no_jamkning' → 0
 *   - totalCorrectionMonths <= 0 → 0 (defensive — caller bug)
 *   - remainingMonths <= 0 → 0 (asset is past the correction period)
 *   - remainingMonths > totalCorrectionMonths → caps at originalInputVat
 *     (sold immediately, before any correction period has elapsed)
 */
export function computeJamkningAmount(input: JamkningInput): number {
  if (input.disposalEvent === 'no_jamkning') return 0
  if (input.totalCorrectionMonths <= 0) return 0
  if (input.remainingMonths <= 0) return 0

  const remaining = Math.min(input.remainingMonths, input.totalCorrectionMonths)
  const raw = (remaining / input.totalCorrectionMonths) * input.originalInputVat
  return Math.round(raw * 100) / 100
}

/**
 * Suggested eligibility check for an asset disposal. Returns the
 * totalCorrectionMonths the caller should pass to computeJamkningAmount,
 * along with the remainingMonths derived from acquisitionDate and
 * disposalDate.
 *
 * The threshold lives here (not in the asset row) because it's a property
 * of the asset CATEGORY / BAS account class, not user-editable per-asset:
 *
 *   - Fastighet (BAS 1100-1199) → 120 months
 *   - Markanläggning (BAS 1150-1159) — also 120 months
 *   - All other movable property → 60 months
 *
 * Pure: takes only dates and the asset's BAS account, returns numbers.
 * Caller decides whether to surface the suggestion in the UI.
 */
export interface JamkningEligibility {
  /** Suggested total correction period (60 or 120 months). */
  totalCorrectionMonths: number
  /** Months elapsed between acquisitionDate and disposalDate (clamped at 0). */
  elapsedMonths: number
  /** Remaining months in the correction period (clamped at 0). */
  remainingMonths: number
  /**
   * Whether the disposal falls WITHIN the correction period. Convenience
   * boolean — equivalent to `remainingMonths > 0`. Caller uses this to
   * show / hide the jämkning UI.
   */
  withinCorrectionPeriod: boolean
}

export function assessJamkningEligibility(args: {
  basExpenseAccount?: string
  basAssetAccount?: string
  category?: AssetCategory
  acquisitionDate: string
  disposalDate: string
}): JamkningEligibility {
  const totalCorrectionMonths = isRealProperty(args) ? 120 : 60
  const elapsed = monthsBetween(args.acquisitionDate, args.disposalDate)
  const elapsedClamped = Math.max(0, elapsed)
  const remaining = Math.max(0, totalCorrectionMonths - elapsedClamped)
  return {
    totalCorrectionMonths,
    elapsedMonths: elapsedClamped,
    remainingMonths: remaining,
    withinCorrectionPeriod: remaining > 0,
  }
}

/**
 * Real property (fastighet / markanläggning) per BAS 1100-1199 lives on
 * the 10-year (120 mån) correction period. Everything else uses 5 years.
 *
 * The plan's contract is that this resolves off the asset's BAS account
 * range, with category as a secondary signal. Two reasons we prefer
 * account-driven over category-driven:
 *   1. The account is what BAS reports / SIE / INK2R actually read; the
 *      category is just a UI label.
 *   2. Users who override the BAS account to something outside the
 *      category's default range get a consistent answer with what their
 *      reports show.
 */
function isRealProperty(args: {
  basExpenseAccount?: string
  basAssetAccount?: string
  category?: AssetCategory
}): boolean {
  // Prefer the asset (anskaffning) account when supplied — it's the most
  // direct mapping to the BAS class.
  const assetAccount = args.basAssetAccount
  if (assetAccount && /^1[1][0-9]{2}$/.test(assetAccount)) return true
  // Expense account check — 7820-7829 = byggnader/markanläggning.
  const expense = args.basExpenseAccount
  if (expense && /^782[0-9]$/.test(expense)) return true
  // Category fallback for callers who only have the asset row's category
  // (e.g. UI that hasn't loaded the full asset yet).
  if (args.category === 'building' || args.category === 'land_improvement') {
    return true
  }
  return false
}

/**
 * Calendar months between two ISO date strings, rounded toward zero.
 * Counts complete months only — partial months don't tick the clock.
 *
 * The Swedish tax authorities count months, not days, for jämkning
 * (ML 8a kap 6 §). Example: acquired 2023-01-15, sold 2026-01-14 →
 * 35 months elapsed (the 36th month hasn't completed yet).
 */
function monthsBetween(fromIso: string, toIso: string): number {
  const from = parseIsoDate(fromIso)
  const to = parseIsoDate(toIso)
  if (!from || !to) return 0
  let months = (to.year - from.year) * 12 + (to.month - from.month)
  if (to.day < from.day) months -= 1
  return months
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return null
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  }
}
