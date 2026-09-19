/**
 * Vacation categories on payslip lines and the pools they draw from.
 *
 * A vacation line (item_type 'vacation', quantity = days) may name the pool
 * it consumes in the five categories Fortnox and Azets use: Betalda (paid),
 * Extra betalda (extra_paid), Sparade (saved, optionally from one origin
 * year), Obetalda (unpaid) and Förskott (advance). NULL means paid, which is
 * what every line written before the column existed meant.
 *
 * The ledger (vacation-ledger.ts) recomputes the pools from booked runs on
 * every sync, so the allocation here is a pure function of the booked lines
 * and the seeded balances: idempotent and self-healing like taken_days.
 *
 * Shared by the payslip-line commands (400 before the DB CHECK 23514), the
 * ledger sync, the year close and the vacation-balance readers.
 */

import { roundOre } from '@/lib/money'

export const VACATION_CATEGORIES = ['paid', 'extra_paid', 'saved', 'unpaid', 'advance'] as const
export type VacationCategory = (typeof VACATION_CATEGORIES)[number]

export const VACATION_CATEGORY_VALIDATION_MESSAGE =
  'Semesterkategori kan bara anges på en semesterrad (item_type vacation)'
export const VACATION_SAVED_YEAR_VALIDATION_MESSAGE =
  'Sparår (vacation_saved_year) kan bara anges tillsammans med kategorin saved och måste vara ett fyrsiffrigt år'

export interface VacationCategoryLineShape {
  item_type: string
  vacation_category?: string | null
  vacation_saved_year?: string | null
}

/**
 * Null when the line is acceptable, otherwise the Swedish user-facing reason.
 * A line without a category is always acceptable (paid by default). Mirrors
 * the two salary_line_items CHECKs in migration 20260919130100.
 */
export function validateVacationCategoryLine(line: VacationCategoryLineShape): string | null {
  const category = line.vacation_category
  const savedYear = line.vacation_saved_year
  if (category !== null && category !== undefined) {
    if (line.item_type !== 'vacation') return VACATION_CATEGORY_VALIDATION_MESSAGE
    if (!(VACATION_CATEGORIES as readonly string[]).includes(category)) {
      return VACATION_CATEGORY_VALIDATION_MESSAGE
    }
  }
  if (savedYear !== null && savedYear !== undefined) {
    if (category !== 'saved') return VACATION_SAVED_YEAR_VALIDATION_MESSAGE
    if (!/^\d{4}$/.test(savedYear)) return VACATION_SAVED_YEAR_VALIDATION_MESSAGE
  }
  return null
}

/** The day before an ISO date (the default vacation as-of date at cutover). */
export function dayBefore(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The day an opening balance's vacation pools are struck per. NULL falls
 * back to the day before cutover_date: every booked run whose
 * avvikelseperiod ends on or before this day was already inside the
 * migrated balance and is not deducted again.
 */
export function effectiveVacationAsOfDate(opening: {
  cutover_date: string
  vacation_as_of_date?: string | null
}): string {
  return opening.vacation_as_of_date ?? dayBefore(opening.cutover_date)
}

export interface VacationLineLike {
  item_type: string
  quantity: number | null
  vacation_category?: string | null
  vacation_saved_year?: string | null
  sort_order?: number | null
}

export interface BookedVacationSource {
  /** The run's stored vacation_days_taken: the sum of every vacation line. */
  vacation_days_taken: number
  /** Embedded payslip lines; absent on rows selected without the embed. */
  line_items?: VacationLineLike[] | null
}

export interface VacationTakenSplit {
  /** Days from the paid pool (paid + extra_paid + uncategorized). */
  paid: number
  unpaid: number
  advance: number
  /** Sparade dagar consumed, by origin year. */
  savedByYear: Record<string, number>
}

/**
 * Split the vacation days of booked runs (given in chronological order) by
 * category. The paid share is derived as vacation_days_taken minus the
 * categorized non-paid lines, so a run without categorized lines (or without
 * the line embed at all) contributes exactly its stored vacation_days_taken,
 * byte for byte what the ledger summed before categories existed.
 *
 * Saved lines that name an origin year consume that year. Lines without a
 * year take the oldest seeded year first (the one that expires first), then
 * the next; anything beyond the seeded years lands on the oldest seeded year,
 * or on `fallbackYear` when nothing is seeded, so the consumption is never
 * silently dropped.
 */
export function splitVacationTaken(
  runs: BookedVacationSource[],
  seedSaved: Record<string, number>,
  fallbackYear: string,
): VacationTakenSplit {
  const split: VacationTakenSplit = { paid: 0, unpaid: 0, advance: 0, savedByYear: {} }
  const seedYears = Object.keys(seedSaved)
    .filter((year) => (Number(seedSaved[year]) || 0) > 0)
    .sort()

  const consumeSaved = (year: string, days: number) => {
    split.savedByYear[year] = roundOre((split.savedByYear[year] ?? 0) + days)
  }
  const allocateOldestFirst = (days: number) => {
    let left = days
    for (const year of seedYears) {
      if (left <= 0) break
      const available = roundOre((Number(seedSaved[year]) || 0) - (split.savedByYear[year] ?? 0))
      if (available <= 0) continue
      const take = Math.min(available, left)
      consumeSaved(year, take)
      left = roundOre(left - take)
    }
    if (left > 0) consumeSaved(seedYears[0] ?? fallbackYear, left)
  }

  for (const run of runs) {
    let nonPaid = 0
    const lines = (run.line_items ?? [])
      .filter((li) => li.item_type === 'vacation' && (li.quantity ?? 0) > 0)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    for (const li of lines) {
      const days = li.quantity ?? 0
      switch (li.vacation_category) {
        case 'saved':
          nonPaid = roundOre(nonPaid + days)
          if (li.vacation_saved_year) consumeSaved(li.vacation_saved_year, days)
          else allocateOldestFirst(days)
          break
        case 'unpaid':
          nonPaid = roundOre(nonPaid + days)
          split.unpaid = roundOre(split.unpaid + days)
          break
        case 'advance':
          nonPaid = roundOre(nonPaid + days)
          split.advance = roundOre(split.advance + days)
          break
        default:
          // paid, extra_paid and NULL all draw from the paid pool.
          break
      }
    }
    split.paid = roundOre(split.paid + Math.max(0, roundOre((run.vacation_days_taken || 0) - nonPaid)))
  }
  return split
}

/**
 * Sparade dagar left per origin year: seed minus consumption. Every seeded
 * year keeps its key (a seed with no consumption reads back unchanged).
 */
export function remainingSavedDays(
  seed: Record<string, number> | null | undefined,
  taken: Record<string, number> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [year, days] of Object.entries(seed ?? {})) {
    out[year] = roundOre((Number(days) || 0) - (Number(taken?.[year]) || 0))
  }
  for (const [year, days] of Object.entries(taken ?? {})) {
    if (year in (seed ?? {})) continue
    const consumed = Number(days) || 0
    // Consumption from a year that was never seeded: surface as negative,
    // never clamp (the vacation-balance route's rule for overdrawn pools).
    if (consumed > 0) out[year] = roundOre(-consumed)
  }
  return out
}

export function sumDays(record: Record<string, number> | null | undefined): number {
  return roundOre(Object.values(record ?? {}).reduce((s, d) => s + (Number(d) || 0), 0))
}
