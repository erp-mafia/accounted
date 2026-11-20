/**
 * Semesterlön percentage under procentregeln (Semesterlagen 16 b §).
 *
 * The statute is a floor: 12 % of the semesterlönegrundande income, raised
 * to 14.4 % when the employee is entitled to 30 days. A kollektivavtal may
 * set a higher rate (2 a §: deviations in the employee's favour); 13 % and
 * 13.5 % are common in LO agreements. The CBA rate lives on the employee
 * master row as `vacation_pay_rate`; null means "statutory".
 *
 * This is the ONE place the rate is derived. The run engine (accrual and
 * semesterersättning payout), the absence valuation, the year-close day
 * valuation and the v1/MCP vacation-balance estimate all call it, so a CBA
 * rate cannot apply in one place and not another.
 *
 * Sammalöneregeln uses it only for the rörliga lönedelar (16 a § tredje
 * stycket, lib/salary/variable-vacation-pay.ts): its semestertillägg is
 * `semestertillagg_rate`, a separate field.
 */

import { roundOre } from '@/lib/money'

export const STATUTORY_VACATION_PAY_RATE = 0.12
export const STATUTORY_VACATION_PAY_RATE_30_DAYS = 0.144

/** The statutory rate for an entitlement: 12 %, or 14.4 % at 30 days. */
export function statutoryVacationPayRate(vacationDaysPerYear: number): number {
  return vacationDaysPerYear >= 30
    ? STATUTORY_VACATION_PAY_RATE_30_DAYS
    : STATUTORY_VACATION_PAY_RATE
}

/**
 * The effective procentregeln rate for an employee: the kollektivavtal
 * rate when it is ABOVE the statutory rate for their entitlement, else the
 * statutory rate. The statutory rate is a floor per entitlement
 * (Semesterlagen 16 b §: 12 %, 14.4 % at 30 days) and a kollektivavtal may
 * only improve on it (2 a §), so 13.5 % on a 30-day employee still accrues
 * 14.4 %. The DB CHECK and Zod bounds (0.12..0.30) cannot see the
 * entitlement; this is where the per-employee floor is enforced.
 */
export function resolveVacationPayRate(
  vacationDaysPerYear: number,
  vacationPayRate: number | null | undefined,
): number {
  const statutory = statutoryVacationPayRate(vacationDaysPerYear)
  if (typeof vacationPayRate === 'number' && Number.isFinite(vacationPayRate) && vacationPayRate > statutory) {
    return vacationPayRate
  }
  return statutory
}

/**
 * Form helpers: the UI shows the rate as a percentage ("13,5"), the row
 * stores a fraction (0.135). Empty input means "statutory" (null).
 */
export function vacationPayRateFromPercentInput(raw: unknown): number | null {
  const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : ''
  if (text === '') return null
  const percent = Number(text)
  if (!Number.isFinite(percent)) return null
  // Two decimals of a percentage = four decimals of the fraction.
  return roundOre(percent) / 100
}

export function vacationPayRateToPercent(rate: number | null | undefined): number | '' {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return ''
  return roundOre(rate * 100)
}

/**
 * Sammalöneregeln semestertillägg (Semesterlagen 16 a §): at least 0,43 % of
 * the månadslön per paid vacation day; many kollektivavtal set 0,8 %. The
 * default of employees.semestertillagg_rate.
 */
export const STATUTORY_SEMESTERTILLAGG_RATE = 0.0043

/**
 * Form helpers for "Semestertillägg": the UI shows a percentage ("0,8"), the
 * row stores a fraction (0.008). Empty input means the statutory 0,43 %; an
 * unparseable one is undefined (the key is left out of the request). Three
 * decimals of a percentage are kept (0,605 %). Range checks stay with the API
 * schema (0..0.05), so an out-of-range entry gets the server's 400.
 */
export function semestertillaggRateFromPercentInput(raw: unknown): number | undefined {
  const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : ''
  if (text === '') return STATUTORY_SEMESTERTILLAGG_RATE
  const percent = Number(text)
  if (!Number.isFinite(percent)) return undefined
  return Math.round(percent * 1000) / 100000
}

export function semestertillaggRateToPercent(rate: number | null | undefined): number | '' {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return ''
  return Math.round(rate * 100000) / 1000
}

/**
 * True when a semestertillägg is below the statutory 0,43 % (Semesterlagen
 * 16 a §). The forms warn, they do not refuse: the API keeps 0..0.05, so a
 * deviating agreement stays enterable. Compared in thousandths of a percent,
 * the precision the form keeps, so 0,43 entered is never "below" 0.0043.
 */
export function isBelowStatutorySemestertillagg(rate: number | null | undefined): boolean {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return false
  return Math.round(rate * 100000) < Math.round(STATUTORY_SEMESTERTILLAGG_RATE * 100000)
}

/**
 * Form helper for "Semesterdagar per år": 0 is a real value (vacation_rule
 * none, e.g. a company owner outside semesterlagen), so only an empty or
 * unparseable field reads as null (callers pick their default).
 * `parseInt(...) || 25` turned an entered 0 into 25.
 */
export function vacationDaysFromInput(raw: unknown): number | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return null
  const days = Number.parseInt(text, 10)
  return Number.isFinite(days) ? days : null
}
