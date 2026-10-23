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
