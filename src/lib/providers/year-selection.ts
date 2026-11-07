/**
 * The one rule for ticking fiscal years in a provider connection's year
 * picker, shared by the Import page's workspace and the onboarding books act
 * (ProviderStep), the same way preview-counts.ts is.
 *
 * A tick always lands. A run fetches at most `max` years (the preview's
 * maxSelectedYears, MAX_SELECTED_FISCAL_YEARS in the arcim-migration
 * extension), and a selection over that is named here, so the screen says
 * why it cannot go on. The onboarding step used to refuse the tick instead:
 * with six years ticked, an older year's pill stayed off with no reason
 * given, and people clicked it again and again before importing the six it
 * allowed.
 */

export type FiscalYearSelectionProblem = 'none' | 'too_many'

/** The selection with `year` ticked on or off, oldest first. */
export function toggleFiscalYear(selected: readonly number[], year: number): number[] {
  return selected.includes(year)
    ? selected.filter((y) => y !== year)
    : [...selected, year].sort((a, b) => a - b)
}

/**
 * Why the selection cannot be fetched as it stands, or null when it can: no
 * year ticked, or more than `max` (no limit when `max` is null).
 */
export function fiscalYearSelectionProblem(
  selected: readonly number[],
  max: number | null | undefined,
): FiscalYearSelectionProblem | null {
  if (selected.length === 0) return 'none'
  if (max != null && selected.length > max) return 'too_many'
  return null
}

/** The fields of a source fiscal year the default selection reads. */
export interface SelectableFiscalYear {
  year: number
  /** In the preview's default window (the newest three years). */
  inDefaultSelection: boolean
}

/**
 * True when the source has more years than one run may fetch, so the history
 * comes over in several runs and the picker starts from the oldest.
 */
export function needsSeveralRuns(
  sourceYears: readonly SelectableFiscalYear[],
  max: number | null | undefined,
): boolean {
  return max != null && new Set(sourceYears.map((y) => y.year)).size > max
}

/**
 * The years ticked when the picker opens, oldest first. A source that fits in
 * one run keeps the preview's default window (the newest three). A longer
 * history starts from the oldest years the books do not hold yet, at most
 * `max`: imported oldest first, each year's opening balance follows the year
 * before, while an earlier year imported after a later one sends the later
 * year's opening balance to review (crm#1686). With every source year
 * already imported it falls back to the default window.
 */
export function defaultFiscalYearSelection(
  sourceYears: readonly SelectableFiscalYear[],
  max: number | null | undefined,
  importedYears: readonly number[] = [],
): number[] {
  const defaultWindow = [...new Set(sourceYears.filter((y) => y.inDefaultSelection).map((y) => y.year))].sort((a, b) => a - b)
  if (max == null || !needsSeveralRuns(sourceYears, max)) return defaultWindow
  const imported = new Set(importedYears)
  const missing = [...new Set(sourceYears.map((y) => y.year))]
    .filter((year) => !imported.has(year))
    .sort((a, b) => a - b)
  return missing.length > 0 ? missing.slice(0, max) : defaultWindow
}
