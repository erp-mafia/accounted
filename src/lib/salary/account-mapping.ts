import { roundOre } from '@/lib/money'
import type { SalaryLineItemType } from '@/types'

/**
 * Salary account mapping: maps line item types and calculation results
 * to BAS accounts per Swedish chart of accounts standards.
 */

/**
 * Kostnadsersättning (travel-expenses.md, "Utlägg vs kostnadsersättning"):
 * paid out with the salary but outside bruttolön. No skatteavdrag, no
 * arbetsgivaravgifter, no semesterunderlag, not in the AGI gross (FK011).
 * The calculation engine adds these to the net payout only; the booking
 * debits their mapped account on top of the gross reconciliation.
 */
export const TAX_FREE_REIMBURSEMENT_TYPES: readonly SalaryLineItemType[] = [
  'expense_reimbursement',
  'traktamente_taxfree',
  'mileage_taxfree',
]

export function isTaxFreeReimbursementType(itemType: string): boolean {
  return (TAX_FREE_REIMBURSEMENT_TYPES as readonly string[]).includes(itemType)
}

/**
 * A line type that books money. A text row (item_type 'text',
 * lib/salary/text-rows.ts) carries words only and never reaches the
 * booking, so it has no account.
 */
export type MoneyLineItemType = Exclude<SalaryLineItemType, 'text'>

/** Default BAS account for each salary line item type that books money. */
const LINE_ITEM_ACCOUNTS: Record<MoneyLineItemType, string> = {
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
  // Utlägg repaid with the salary (#2331): the cost and moms were booked when
  // the claim was registered against 2820, so the payslip line relieves that
  // liability, never a 7xxx cost. The line normally carries the claim's own
  // liability account in account_number; this is the fallback.
  expense_reimbursement: '2820',
  // Net deductions (nettolöneavdrag): withheld from the payout and owed to a
  // third party, so the default account is the credit-side settlement account,
  // not a 7xxx salary expense. Advance repayments credit the receivable (1613),
  // union fees credit 2794, everything unmapped lands on 2799 Övriga
  // löneavdrag. A benefit payment that names its benefit credits that
  // benefit's cost account (netDeductionAccount below); an unnamed one keeps
  // 7385 Kostnader för fri bil, the dominant co-payment case.
  net_deduction_advance: '1613',
  net_deduction_union: '2794',
  net_deduction_benefit_payment: '7385',
  net_deduction_other: '2799',
  // Öresavrundning: net payout rounded up to whole kronor; the 0-99 öre diff
  // debits the standard rounding account (same account the invoice flows use).
  oresavrundning: '3740',
  // Other
  correction: '7210',
  other: '7210',
}

/** The item types the account map covers: every type that books money. */
export const SALARY_LINE_ITEM_TYPES = Object.keys(LINE_ITEM_ACCOUNTS) as MoneyLineItemType[]

/**
 * The item type's account before any employee context: the tjänsteman
 * account for wage types, the fixed account for everything else. For callers
 * with no employee (the mileage register's tax-free account); a payslip line
 * resolves through lineItemAccount.
 */
export function baseLineItemAccount(itemType: MoneyLineItemType): string {
  return LINE_ITEM_ACCOUNTS[itemType]
}

/** Who a salary line is booked for: the inputs of the account resolver. */
export interface SalaryAccountContext {
  employmentType: string
  /** employees.personnel_category (PersonnelCategory): arbetare book the 70xx
   *  series, tjänstemän 72xx (bas-7xxx.md). Read only for employment_type
   *  'employee'; missing reads tjänsteman. */
  personnelCategory?: string | null
}

// Company owners: företagsledare accounts (7220 löner, 7282 sjuklöner,
// 7286 semesterlöner).
const OWNER_ACCOUNTS: Record<string, string> = { '7210': '7220', '7281': '7282', '7285': '7286' }
// Board members: styrelsearvoden.
const BOARD_ACCOUNTS: Record<string, string> = { '7210': '7240' }
// Arbetare: the kollektivanställda series. OB and övertid follow the base
// wage account (ob-overtime.md), so they land on 7010 with it.
const ARBETARE_ACCOUNTS: Record<string, string> = {
  '7210': '7010',
  '7218': '7018',
  '7281': '7081',
  '7285': '7082',
}

/**
 * The account a payslip line books on when it carries no override.
 *
 * salary_line_items.account_number is an explicit override only: NULL means
 * this default, resolved at booking, so a line follows its item type and the
 * employee's current employment type and category until the run is booked.
 * Rules in order: owners book on the företagsledare accounts, board members
 * on 7240, arbetare on the 70xx series, everyone else on the item type's
 * base account. Owners and board members ignore the category.
 */
export function lineItemAccount(itemType: MoneyLineItemType, ctx: SalaryAccountContext): string {
  const base = LINE_ITEM_ACCOUNTS[itemType]
  if (ctx.employmentType === 'company_owner') return OWNER_ACCOUNTS[base] ?? base
  if (ctx.employmentType === 'board_member') return BOARD_ACCOUNTS[base] ?? base
  if (ctx.personnelCategory === 'arbetare') return ARBETARE_ACCOUNTS[base] ?? base
  return base
}

/**
 * The account a net deduction row books on when it carries no override. A
 * benefit payment that names its benefit (salary_line_items.benefit_type,
 * crm#1492) lowers the cost of THAT benefit: bostad 7381, kost 7382, bil
 * 7385 (bas-7xxx.md), the account the benefit row itself maps to. Unnamed,
 * it keeps the item type's 7385.
 */
export function netDeductionAccount(
  itemType: MoneyLineItemType,
  benefitType: string | null | undefined,
  ctx: SalaryAccountContext,
): string {
  const benefitItemType = `benefit_${benefitType}`
  if (itemType === 'net_deduction_benefit_payment' && benefitType && Object.hasOwn(LINE_ITEM_ACCOUNTS, benefitItemType)) {
    return lineItemAccount(benefitItemType as MoneyLineItemType, ctx)
  }
  return lineItemAccount(itemType, ctx)
}

/**
 * Whether a stored line account is a default the old code cached on the line
 * rather than a deliberate override: the item type's base account (what the
 * write sites without an employment type stored) or the owner/board account
 * for that employment type. Utlägg lines carry the claim's liability
 * account, never a cached default. The backfill migration
 * (20261015010000_salary_line_default_accounts_resolved_at_booking.sql)
 * applies the same rule in SQL; a vitest pins the two together.
 */
export function isCachedDefaultAccount(
  itemType: string,
  account: string | null | undefined,
  employmentType: string,
): boolean {
  if (!account || itemType === 'expense_reimbursement') return false
  if (!Object.hasOwn(LINE_ITEM_ACCOUNTS, itemType)) return false
  const type = itemType as MoneyLineItemType
  return (
    account === baseLineItemAccount(type) ||
    account === lineItemAccount(type, { employmentType, personnelCategory: 'tjansteman' })
  )
}

/** Förändring av semesterlöneskuld: 7090 kollektivanställda, 7290 tjänstemän. */
export type VacationLiabilityChangeAccount = '7090' | '7290'

/**
 * Förändring av semesterlöneskuld for one employee: 7090 for arbetare, 7290
 * for tjänstemän, owners and board members (vacation-pay.md), the same rule
 * as the wage account (an employee whose wages book on 7010 is an arbetare).
 * The run's semesteravsättning, the vacation-year close and the bokslut
 * accrual all read it here.
 */
export function vacationLiabilityChangeAccount(ctx: SalaryAccountContext): VacationLiabilityChangeAccount {
  return lineItemAccount('monthly_salary', ctx) === '7010' ? '7090' : '7290'
}

/**
 * Split a change of the vacation liability over the employees' 7090/7290
 * accounts, pro rata by each employee's liability. Every part is rounded to
 * öre and the largest part absorbs the rounding, so the parts sum to `amount`
 * exactly and the 2920 counter line stays one line. Without any positive
 * liability to weigh by (a drift with nothing owed) the split falls back to
 * headcount, and with no employees at all to 7290.
 */
export function splitVacationLiabilityChange(
  employees: Array<{ account: VacationLiabilityChangeAccount; liability: number }>,
  amount: number,
): Array<{ account: VacationLiabilityChangeAccount; amount: number }> {
  const total = roundOre(amount)
  if (total === 0) return []
  const byLiability = new Map<VacationLiabilityChangeAccount, number>()
  const byHeadcount = new Map<VacationLiabilityChangeAccount, number>()
  for (const emp of employees) {
    byLiability.set(emp.account, (byLiability.get(emp.account) ?? 0) + Math.max(0, emp.liability))
    byHeadcount.set(emp.account, (byHeadcount.get(emp.account) ?? 0) + 1)
  }
  const weights = [...byLiability.values()].some((w) => w > 0) ? byLiability : byHeadcount
  const weighted = [...weights.entries()].filter(([, w]) => w > 0)
  if (weighted.length === 0) return [{ account: '7290', amount: total }]
  const weightSum = weighted.reduce((sum, [, w]) => sum + w, 0)
  const parts = weighted
    .sort(([, a], [, b]) => b - a)
    .map(([account, w]) => ({ account, amount: roundOre((total * w) / weightSum) }))
  parts[0].amount = roundOre(parts[0].amount + total - parts.reduce((sum, p) => sum + p.amount, 0))
  return parts
    .filter((p) => p.amount !== 0)
    .sort((a, b) => a.account.localeCompare(b.account))
}

/** Journal entry accounts for salary booking */
export const SALARY_ACCOUNTS = {
  // Tax withholding (credit)
  TAX_WITHHELD: '2710',       // Personalskatt

  // No bank entry: the net pay is credited on the company's own bank account,
  // which is per company (resolvePrimaryBankAccount), not a payroll constant
  // (issue #3097).

  // Employer contributions
  AVGIFTER_EXPENSE: '7510',   // Lagstadgade sociala avgifter (debit)
  AVGIFTER_LIABILITY: '2731', // Avräkning sociala avgifter (credit)
  // Whole-krona remainder: 2731 holds what Skatteverket actually draws
  // (hela kronor, öretal bortfaller), the öre difference lands here.
  ORESUTJAMNING: '3740',      // Öres- och kronutjämning (credit)

  // Vacation accrual. The expense side is per employee
  // (vacationLiabilityChangeAccount: 7090 arbetare, 7290 everyone else).
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
