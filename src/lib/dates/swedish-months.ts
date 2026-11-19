/**
 * The Swedish month names, lowercase as they are written mid-sentence
 * ("lönespecifikation för juni 2026"). One list for the payroll documents and
 * emails, which each kept their own copy. Pure: safe in client bundles.
 */
export const SWEDISH_MONTH_NAMES = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
] as const

/** The name of month 1-12. */
export function swedishMonthName(month: number): string {
  return SWEDISH_MONTH_NAMES[month - 1]
}
