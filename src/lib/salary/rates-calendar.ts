/**
 * When the repository must carry next year's statutory figures.
 *
 * Payroll is calculated in the payment year: a run paid on 25 January uses
 * that year's arbetsgivaravgifter, prisbasbelopp, statslåneränta and tax
 * tables. Runs for January are prepared in December, so a year's figures must
 * ship before the year turns. They cannot ship much earlier either: the last
 * inputs are set late in the year before (checked 2026-09-28 against the
 * official sources): inkomstbasbelopp in early November, the statslåneränta
 * for bilförmån on 30 November, the skiktgräns for statlig skatt with
 * Skatteverket's SKV 433 (2025-12-10 for 2026), and the tax tables with it.
 * Hence mid-December for the rates and a few days later for the tables.
 *
 * Payroll refuses a year without rates by name (SALARY_PAYROLL_CONFIG_MISSING);
 * the capitalization threshold in lib/bookkeeping/mapping-engine.ts falls back
 * to its latest year with a warning. These dates drive the calendar tripwire
 * tests, which fail CI once a due date has passed without the next year's
 * figures, so the gap is found in December and not by a customer's January
 * payroll.
 */

/** A day of the year, month 1-12, compared in UTC. */
export interface DueDay {
  month: number
  day: number
}

/** Next year's salary_payroll_config row (a migration). */
export const PAYROLL_RATES_DUE: DueDay = { month: 12, day: 15 }

/**
 * Next year's bundled tax tables (lib/salary/tax-tables-fallback.ts, from
 * scripts/import-tax-tables.ts). Only the emergency fallback: Skatteverket's
 * open-data API is the primary source.
 */
export const TAX_TABLE_FALLBACK_DUE: DueDay = { month: 12, day: 20 }

/** True once `due` has been reached in `now`'s own year (UTC). */
export function isDue(due: DueDay, now: Date): boolean {
  const year = now.getUTCFullYear()
  return now.getTime() >= Date.UTC(year, due.month - 1, due.day)
}

/**
 * The years the repository must carry figures for on `now`: the current year,
 * plus the next one once `due` has passed.
 */
export function requiredYears(due: DueDay, now: Date): number[] {
  const year = now.getUTCFullYear()
  return isDue(due, now) ? [year, year + 1] : [year]
}
