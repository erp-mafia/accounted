import type { SalaryLineItemType } from '@/types'

/**
 * Recurring payroll lines (issue #2042): standing per-employee payslip rows
 * derived into every salary run inside their validity window, e.g. a benefit
 * bike bruttolöneavdrag of -670,17 kr/month.
 *
 * This module is pure: item-type whitelist, flag derivation and amount-sign
 * validation. The DB derivation lives in run-calculation.ts (step 8d3) and
 * mirrors the employee_benefits step 8d lifecycle via
 * salary_line_items.source_recurring_line_id.
 */

/** Item types a recurring line may use. Mirrors the table CHECK constraint. */
export const RECURRING_LINE_ITEM_TYPES = [
  'gross_deduction_pension',
  'gross_deduction_other',
  'net_deduction_union',
  'net_deduction_benefit_payment',
  'net_deduction_other',
  'other',
] as const satisfies readonly SalaryLineItemType[]

export type RecurringLineItemType = (typeof RECURRING_LINE_ITEM_TYPES)[number]

export interface RecurringLineFlags {
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
}

/**
 * Derive the salary_line_items flags from the item type instead of storing
 * them: a gross deduction that is not tax-reducing (or a net deduction that
 * is) cannot be expressed, so the payslip math stays consistent by
 * construction.
 *
 * Gross deductions carry the sick-karens convention: negative amount with
 * is_taxable + is_avgift_basis true, so they reduce both the tax base and the
 * arbetsgivaravgift base. Net deductions only move money after tax. Neither
 * accrues semester; a recurring 'other' addition follows the benefit rows in
 * that respect.
 */
export function recurringLineFlags(itemType: RecurringLineItemType): RecurringLineFlags {
  if (itemType === 'gross_deduction_pension' || itemType === 'gross_deduction_other') {
    return {
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
      is_net_deduction: false,
    }
  }
  if (itemType === 'other') {
    return {
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    }
  }
  return {
    is_taxable: false,
    is_avgift_basis: false,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: true,
  }
}

/** Shared 400 copy: schema, route backstop and UI hint say the same thing. */
export const RECURRING_LINE_AMOUNT_SIGN_MESSAGE =
  'Avdragsrader måste ha negativt belopp och tilläggsrader positivt belopp.'

/**
 * Validate the amount sign for an item type. Returns an error message or
 * null. Mirrors the employee_recurring_lines_amount_sign CHECK so bad input
 * is a 400 with field-level feedback rather than a Postgres 23514.
 */
export function validateRecurringLineAmount(
  itemType: RecurringLineItemType,
  amount: number,
): string | null {
  if (!Number.isFinite(amount) || amount === 0) return RECURRING_LINE_AMOUNT_SIGN_MESSAGE
  const isDeduction = itemType !== 'other'
  if (isDeduction && amount >= 0) return RECURRING_LINE_AMOUNT_SIGN_MESSAGE
  if (!isDeduction && amount <= 0) return RECURRING_LINE_AMOUNT_SIGN_MESSAGE
  return null
}
