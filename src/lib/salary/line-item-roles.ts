/**
 * What every payslip line type does to the pay: one explicit role per type.
 *
 * The calculation (calculation-engine.ts) reads its input lines through
 * per-step lists, so a type on no list was accepted, stored and printed on the
 * payslip but paid nothing, without a word. An hourly_salary row added for
 * extra hours on a monthly-paid payslip fell through exactly like that, while
 * an 'other' row with the same flags was paid (crm#1331). The engine's lists
 * now come from this map, which must name every type (a Record over
 * SalaryLineItemType: a new type without a role does not compile), and a test
 * runs every accepted type through the engine to prove some step consumes it.
 *
 * Grundlön and Timlön (monthly_salary, hourly_salary) are the one pair whose
 * meaning depends on the payslip. The calculation prices the base pay of the
 * employee's pay type itself (Step 1: the monthly salary, or timlön x worked
 * hours) and writes a row of that type to show it: that row is a display of
 * Step 1, never an input. A row of the other base type is ordinary pay on top
 * of it: extra hours at timlön (mertid) on a monthly-paid payslip are wages,
 * taxed, in the avgiftsunderlag and semesterlönegrundande like any other
 * hourly pay (swedish-payroll ob-overtime.md: mertid is "usually plain hourly
 * pay"). Under sammalöneregeln it is pay outside the monthly salary, so it
 * earns semesterlön as variable pay (vacation-pay.md), as an 'other' row does.
 *
 * The pay type, not a stored marker, says which row is the display: the
 * calculation prices exactly one base per payslip from the pay type. A marker
 * would need every existing base row backfilled, and a row written without it
 * (an older deploy, a missed writer) would then be paid twice.
 */
import type { SalaryLineItemType } from '@/types'
import { baseSalaryLineType } from './base-salary-line'

export type PayslipLineRole =
  /** Grundlön or Timlön: the display of Step 1 on its own pay type, a Step 2 addition on the other. */
  | 'base_salary'
  /** Step 2: summed into gross pay with its sign (when taxable and not flagged as a deduction). */
  | 'addition'
  /** Step 3: signed absence (sjuklön, karens, VAB, föräldraledighet, tjänstledighet, semester). */
  | 'absence'
  /** Step 4: bruttolöneavdrag, consumed by is_gross_deduction. */
  | 'gross_deduction'
  /** Step 5: förmånsvärde, in the tax base and the avgiftsunderlag but not paid out. */
  | 'benefit'
  /** Step 7: nettolöneavdrag, consumed by is_net_deduction. */
  | 'net_deduction'
  /** Step 7a: kostnadsersättning, paid out with the net and outside gross. */
  | 'reimbursement'
  /** Step 7b output: written from the result, never an input (the line commands refuse it). */
  | 'net_rounding'
  /** Words only: never reaches the calculation, the booking or the AGI (text-rows.ts). */
  | 'text'

export const PAYSLIP_LINE_ROLES: Record<SalaryLineItemType, PayslipLineRole> = {
  monthly_salary: 'base_salary',
  hourly_salary: 'base_salary',
  overtime: 'addition',
  overtime_50: 'addition',
  overtime_100: 'addition',
  ob_weekday_evening: 'addition',
  ob_weekend: 'addition',
  ob_night: 'addition',
  ob_holiday: 'addition',
  bonus: 'addition',
  commission: 'addition',
  gross_deduction_pension: 'gross_deduction',
  gross_deduction_other: 'gross_deduction',
  benefit_car: 'benefit',
  benefit_housing: 'benefit',
  benefit_meals: 'benefit',
  benefit_wellness: 'benefit',
  benefit_bike: 'benefit',
  benefit_other: 'benefit',
  sick_karens: 'absence',
  sick_day2_14: 'absence',
  sick_day15_plus: 'absence',
  vab: 'absence',
  parental_leave: 'absence',
  unpaid_leave: 'absence',
  vacation: 'absence',
  semesterersattning: 'addition',
  traktamente_taxfree: 'reimbursement',
  traktamente_taxable: 'addition',
  mileage_taxfree: 'reimbursement',
  mileage_taxable: 'addition',
  expense_reimbursement: 'reimbursement',
  net_deduction_advance: 'net_deduction',
  net_deduction_union: 'net_deduction',
  net_deduction_benefit_payment: 'net_deduction',
  net_deduction_other: 'net_deduction',
  oresavrundning: 'net_rounding',
  correction: 'addition',
  other: 'addition',
  text: 'text',
}

/** Every type with one of the roles, in map order. */
export function lineTypesWithRole(...roles: PayslipLineRole[]): SalaryLineItemType[] {
  return (Object.keys(PAYSLIP_LINE_ROLES) as SalaryLineItemType[]).filter((type) =>
    roles.includes(PAYSLIP_LINE_ROLES[type]),
  )
}

export function isBaseSalaryLineType(itemType: unknown): itemType is 'monthly_salary' | 'hourly_salary' {
  return itemType === 'monthly_salary' || itemType === 'hourly_salary'
}

/**
 * True for a payslip's Grundlön or Timlön display row: a base-salary row of
 * the base type of one of the given pay types. Several pay types are passed
 * while a payslip changes pay type (the run's snapshot and the employee's
 * current one: until the next calculation swaps the row, either may be the
 * display). With no known pay type every base-salary row is treated as the
 * display, the reading before crm#1331, so an unknown payslip never counts
 * its base pay twice.
 */
export function isBaseSalaryDisplayLine(
  itemType: unknown,
  payTypes: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!isBaseSalaryLineType(itemType)) return false
  const known = payTypes.filter((t): t is string => t === 'monthly' || t === 'hourly')
  if (known.length === 0) return true
  return known.some((payType) => baseSalaryLineType(payType) === itemType)
}
