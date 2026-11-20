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

/** The five flags a payslip row is stored with. */
export type PayslipLineFlags = {
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
}

/** Words, a kostnadsersättning at or under the schablon, the öresavrundning: no pay. */
const NO_PAY: PayslipLineFlags = {
  is_taxable: false,
  is_avgift_basis: false,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
}
/** A wage: taxed, in the avgiftsunderlag, semesterlönegrundande. */
const WAGE: PayslipLineFlags = { ...NO_PAY, is_taxable: true, is_avgift_basis: true, is_vacation_basis: true }
/** Taxed and in the avgiftsunderlag, but no semesterlön is earned on it. */
const NOT_VACATION_BASIS: PayslipLineFlags = { ...WAGE, is_vacation_basis: false }
/**
 * Reduces both the tax base and the avgiftsunderlag, stays out of the semester
 * base (the loneväxling-style choice). The absence rows carry the same flags:
 * the engine reads them by type, so is_gross_deduction only drives their
 * booking split there.
 */
const GROSS_DEDUCTION: PayslipLineFlags = { ...NOT_VACATION_BASIS, is_gross_deduction: true }
/** Moves money after tax, and nothing else. */
const NET_DEDUCTION: PayslipLineFlags = { ...NO_PAY, is_net_deduction: true }

const FLAGS_BY_ROLE: Record<PayslipLineRole, PayslipLineFlags> = {
  base_salary: WAGE,
  addition: WAGE,
  absence: GROSS_DEDUCTION,
  gross_deduction: GROSS_DEDUCTION,
  benefit: NOT_VACATION_BASIS,
  net_deduction: NET_DEDUCTION,
  reimbursement: NO_PAY,
  net_rounding: NO_PAY,
  text: NO_PAY,
}

/** The types whose flags their role does not settle. */
const FLAGS_BY_TYPE: Partial<Record<SalaryLineItemType, PayslipLineFlags>> = {
  // Above Skatteverket's schablon: taxed as salary, not semestergrundande.
  traktamente_taxable: NOT_VACATION_BASIS,
  mileage_taxable: NOT_VACATION_BASIS,
  // Semesterlön earns no semesterlön (SemL 16 §).
  semesterersattning: NOT_VACATION_BASIS,
  vacation: NOT_VACATION_BASIS,
  // Försäkringskassan's phase: no pay from the employer, so no underlag.
  sick_day15_plus: { ...GROSS_DEDUCTION, is_avgift_basis: false },
  // Not semesterlönegrundande, so the pay never earned lowers the base; the
  // row is Step 3's and stays out of the gross deduction total.
  unpaid_leave: WAGE,
}

/**
 * The flags of a payslip row: what the row is, never what a door said. Every
 * writer of salary_line_items takes them from here, so a row of one type means
 * the same whichever door wrote it. The API and MCP doors used to default
 * every type to pay and store what the caller sent, so a nettolöneavdrag
 * through them never left the pay (`net_deduction_other` -500: 7210 D 40 500
 * where the dashboard books D 40 000).
 *
 * The calculation owns two refinements a type cannot carry, both on rows it
 * derives itself, and both start from these flags: whether a day of VAB or
 * parental leave is semesterlönegrundande (SemL 17-17 a §§,
 * derive-absence-line-items.ts) and which vacation pay rows replace salary
 * (vacation-days-pay.ts).
 */
export function payslipLineFlags(itemType: SalaryLineItemType): PayslipLineFlags {
  return FLAGS_BY_TYPE[itemType] ?? FLAGS_BY_ROLE[PAYSLIP_LINE_ROLES[itemType]]
}

/**
 * What the sign of a row's amount means:
 *   positive: above zero or it means nothing. A förmånsvärde is a value
 *     received, and a kostnadsersättning money paid out: the voucher posted a
 *     negative ersättning as a credit the pay never saw, and refused it as
 *     unbalanced.
 *   negative: a bruttolöneavdrag, below zero. Löneväxling only reaches future
 *     earnings (swedish-payroll deductions-lonevaxling.md), and pay handed back
 *     before tax is pay: a `correction` row carries it.
 *   repayable: a nettolöneavdrag. Below zero withholds, above zero repays the
 *     employee, in the calculation, the booking and the förmån resolver alike.
 *     It is the only row that can: the money went after tax.
 *   signed: pay and absence, summed with their sign: a retroactive correction
 *     can be negative, an absence row is.
 *   none: a text row has no amount.
 */
export type PayslipLineSign = 'positive' | 'negative' | 'repayable' | 'signed' | 'none'

const SIGN_BY_ROLE: Record<PayslipLineRole, PayslipLineSign> = {
  base_salary: 'signed',
  addition: 'signed',
  absence: 'signed',
  gross_deduction: 'negative',
  benefit: 'positive',
  net_deduction: 'repayable',
  reimbursement: 'positive',
  net_rounding: 'signed',
  text: 'none',
}

export function payslipLineSign(itemType: SalaryLineItemType): PayslipLineSign {
  return SIGN_BY_ROLE[PAYSLIP_LINE_ROLES[itemType]]
}

/** A bruttolöneavdrag or nettolöneavdrag: withheld from the pay, so stored negative when entered. */
export function isDeductionLineType(itemType: SalaryLineItemType): boolean {
  const sign = payslipLineSign(itemType)
  return sign === 'negative' || sign === 'repayable'
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

/** The display line a pay type is shown with: Grundlön or Timlön. */
export function baseSalaryLineType(salaryType: string): 'monthly_salary' | 'hourly_salary' {
  return salaryType === 'monthly' ? 'monthly_salary' : 'hourly_salary'
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
