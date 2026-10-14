import type { SalaryLineItemType } from '@/types'
import { TEXT_ROW_AMOUNT_MESSAGE, TEXT_ROW_FLAGS, TEXT_ROW_ITEM_TYPE } from '@/lib/salary/text-rows'

/**
 * Recurring payroll lines (issue #2042): standing per-employee payslip rows
 * derived into every salary run inside their validity window, e.g. a benefit
 * bike bruttolöneavdrag of -670,17 kr/month, or a text row explaining how the
 * salary is built up.
 *
 * This module is pure: item-type whitelist, flag derivation and amount-sign
 * validation. The DB derivation lives in run-calculation.ts (step 8d3) and
 * mirrors the employee_benefits step 8d lifecycle via
 * salary_line_items.source_recurring_line_id. Every other list of recurring
 * types (the Zod enum, the dashboard panel) is derived from
 * RECURRING_LINE_ITEM_TYPES and RECURRING_LINE_LABELS here.
 */

/** Item types a recurring line may use. Mirrors the table CHECK constraint. */
export const RECURRING_LINE_ITEM_TYPES = [
  'gross_deduction_pension',
  'gross_deduction_other',
  'net_deduction_union',
  'net_deduction_benefit_payment',
  'net_deduction_other',
  'text',
] as const satisfies readonly SalaryLineItemType[]

export type RecurringLineItemType = (typeof RECURRING_LINE_ITEM_TYPES)[number]

/**
 * Swedish default description per type, written to the row when the user
 * leaves the description empty (stored data stays Swedish whatever the UI
 * locale). A text row has no default: its words are the whole row.
 */
export const RECURRING_LINE_LABELS: Record<Exclude<RecurringLineItemType, 'text'>, string> = {
  gross_deduction_pension: 'Bruttolöneavdrag pension (löneväxling)',
  gross_deduction_other: 'Bruttolöneavdrag',
  net_deduction_union: 'Fackavgift',
  net_deduction_benefit_payment: 'Nettolöneavdrag förmån',
  net_deduction_other: 'Nettolöneavdrag',
}

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
 * touches the semester base (is_vacation_basis false on the deduction row:
 * the loneväxling-style choice recorded in DECISIONS.md).
 *
 * A text row carries no flags at all (lib/salary/text-rows.ts): it never
 * reaches the engine or the booking.
 *
 * Recurring ADDITIONS ('other', a "Personligt tillägg" next to Grundlön) are
 * deliberately not supported. Proration for a partial month, absence
 * deductions, sjuklön, semestertillägg and the OB hourly rate all read only
 * monthly_salary, so a standing tillägg row would be paid in full through
 * sick leave. A standing raise belongs on monthly_salary;
 * the payslip can explain how it is built up with a text row.
 */
export function recurringLineFlags(itemType: RecurringLineItemType): RecurringLineFlags {
  if (itemType === TEXT_ROW_ITEM_TYPE) return { ...TEXT_ROW_FLAGS }
  if (itemType === 'gross_deduction_pension' || itemType === 'gross_deduction_other') {
    return {
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
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
  'Återkommande rader är avdrag och måste ha negativt belopp.'

/**
 * Validate the amount for an item type. Returns an error message or null.
 * Mirrors the employee_recurring_lines_amount_sign and _text_row CHECKs so
 * bad input is a 400 with field-level feedback rather than a Postgres 23514:
 * a deduction is negative, a text row has none (omitted or 0).
 */
export function validateRecurringLineAmount(
  itemType: RecurringLineItemType,
  amount: number | null | undefined,
): string | null {
  if (itemType === TEXT_ROW_ITEM_TYPE) return (amount ?? 0) === 0 ? null : TEXT_ROW_AMOUNT_MESSAGE
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount >= 0) return RECURRING_LINE_AMOUNT_SIGN_MESSAGE
  return null
}
