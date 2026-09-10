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
 * Sammalöneregeln does not use this rate: its semestertillägg is
 * `semestertillagg_rate`, a separate field.
 */

import { roundOre } from '@/lib/money'

export const STATUTORY_VACATION_PAY_RATE = 0.12
export const STATUTORY_VACATION_PAY_RATE_30_DAYS = 0.144

/** Bounds enforced by the DB CHECK and the Zod schemas. Below 12 % is
 * illegal for every entitlement; above 30 % is a typo (13.5 entered as
 * 0.135 is fine, 13.5 entered raw is not). The entitlement-dependent floor
 * (14.4 % at 30 days) is enforced by resolveVacationPayRate, not here. */
export const VACATION_PAY_RATE_MIN = STATUTORY_VACATION_PAY_RATE
export const VACATION_PAY_RATE_MAX = 0.3

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
