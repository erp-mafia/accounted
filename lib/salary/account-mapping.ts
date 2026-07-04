import type { SalaryLineItemType } from '@/types'

/**
 * Salary account mapping: maps line item types and calculation results
 * to BAS accounts per Swedish chart of accounts standards.
 */

/** Default BAS account for each salary line item type */
const LINE_ITEM_ACCOUNTS: Record<SalaryLineItemType, string> = {
  // Salary components
  monthly_salary: '7210',
  hourly_salary: '7210',
  overtime: '7210',
  overtime_50: '7210',
  overtime_100: '7210',
  // OB-tillägg: bookat på samma lönekonto som grundlönen; differentieras via
  // rad-text på verifikatet och lönespecifikationen.
  ob_weekday_evening: '7210',
  ob_weekend: '7210',
  ob_night: '7210',
  ob_holiday: '7210',
  bonus: '7210',
  commission: '7210',
  // Gross deductions
  gross_deduction_pension: '7218',
  gross_deduction_other: '7210',
  // Benefits (förmånsvärden: not a cash payment, just tax base)
  benefit_car: '7385',
  benefit_housing: '7381',
  benefit_meals: '7382',
  benefit_wellness: '7699',
  benefit_bike: '7388',
  benefit_other: '7389',
  // Absence
  sick_karens: '7281',
  sick_day2_14: '7281',
  sick_day15_plus: '7281',
  vab: '7210',
  parental_leave: '7210',
  unpaid_leave: '7210',
  vacation: '7285',
  semesterersattning: '7285',
  // Travel
  traktamente_taxfree: '7321',
  traktamente_taxable: '7322',
  mileage_taxfree: '7331',
  mileage_taxable: '7332',
  // Net deductions
  net_deduction_advance: '7210',
  net_deduction_union: '7210',
  net_deduction_benefit_payment: '7385',
  net_deduction_other: '7210',
  // Other
  correction: '7210',
  other: '7210',
}

/**
 * Get the BAS account number for a salary line item type.
 * Can be overridden per line item via account_number field.
 */
export function getLineItemAccount(
  itemType: SalaryLineItemType,
  employmentType: string = 'employee'
): string {
  // Company owner uses 7220 instead of 7210
  if (employmentType === 'company_owner') {
    const baseAccount = LINE_ITEM_ACCOUNTS[itemType]
    if (baseAccount === '7210') return '7220'
    if (baseAccount === '7281') return '7282'
    if (baseAccount === '7285') return '7286'
  }

  // Board member uses 7240
  if (employmentType === 'board_member') {
    const baseAccount = LINE_ITEM_ACCOUNTS[itemType]
    if (baseAccount === '7210') return '7240'
  }
  return LINE_ITEM_ACCOUNTS[itemType]
}

/** Journal entry accounts for salary booking */
export const SALARY_ACCOUNTS = {
  // Salary expense (debit)
  SALARY_EMPLOYEE: '7210',    // Löner till tjänstemän
  SALARY_OWNER: '7220',       // Löner till företagsledare
  SALARY_BOARD: '7240',       // Styrelsearvoden
  SICK_PAY: '7281',           // Sjuklöner
  VACATION_PAY: '7285',       // Semesterlöner

  // Tax withholding (credit)
  TAX_WITHHELD: '2710',       // Personalskatt

  // Bank / payment (credit)
  BANK: '1930',               // Företagskonto

  // Employer contributions
  AVGIFTER_EXPENSE: '7510',   // Lagstadgade sociala avgifter (debit)
  AVGIFTER_LIABILITY: '2731', // Avräkning sociala avgifter (credit)

  // Vacation accrual
  VACATION_ACCRUAL_EXPENSE: '7290',   // Förändring semesterlöneskuld (debit)
  VACATION_ACCRUAL_LIABILITY: '2920', // Upplupna semesterlöner (credit)

  // Vacation accrual avgifter
  VACATION_AVGIFTER_EXPENSE: '7519',   // Sociala avgifter semester (debit)
  VACATION_AVGIFTER_LIABILITY: '2940', // Upplupna sociala avgifter (credit)

  // Pension provisions (löneväxling)
  PENSION_EXPENSE: '7410',             // Pensionsförsäkringspremier (debit)
  PENSION_LIABILITY: '2740',           // Skuld pensionsförsäkringar (credit)
  SLP_EXPENSE: '7533',                // Särskild löneskatt på pensionskostnader (debit)
  SLP_LIABILITY: '2514',              // Beräknad särskild löneskatt (credit)
} as const
