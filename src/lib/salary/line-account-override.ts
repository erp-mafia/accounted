/**
 * Which payslip and recurring rows offer an account override, and which
 * accounts the override may name.
 *
 * salary_line_items.account_number (and employee_recurring_lines.
 * account_number) is an override only: without one the booking resolves the
 * default from the item type and the employee (account-mapping.ts
 * lineItemAccount). An override only means something on a row that posts on
 * its own account, so the picker is left off:
 *   - benefits (förmånsvärden): tax base only, no verifikat line;
 *   - absence rows and the other calculated types: the calculation deletes
 *     and re-derives them, so an override would not survive;
 *   - gross deductions: they reduce the base salary debit and never post a
 *     line of their own (salary-entries.ts buildSalaryLines);
 *   - utlägg: the line carries the claim's own liability account;
 *   - öresavrundning: always 3740;
 *   - text rows: words only, no money and no account (text-rows.ts).
 *
 * Pay rows (wages, kostnadsersättning) book a personnel cost, so their
 * override is limited to class 7. Net deductions credit a settlement account
 * (2794 fackavgift, 1613 förskott, 7385/7381 for a benefit co-payment) and may
 * name any account.
 */
import { isCalculatedLineType } from '@/lib/salary/calculated-line-items'

export type LineAccountOverride = 'none' | 'class_7' | 'any'

// Utlägg, the rounding row, the vacation-day row the absence register
// writes, and the text row.
const NO_OVERRIDE_TYPES = new Set(['expense_reimbursement', 'oresavrundning', 'vacation', 'text'])

export function lineAccountOverride(itemType: string): LineAccountOverride {
  if (itemType.startsWith('benefit_')) return 'none'
  if (itemType.startsWith('gross_deduction_')) return 'none'
  if (NO_OVERRIDE_TYPES.has(itemType)) return 'none'
  if (isCalculatedLineType(itemType)) return 'none'
  if (itemType.startsWith('net_deduction_')) return 'any'
  return 'class_7'
}

/** Whether `account` is a number the row's override may name. */
export function isAllowedOverrideAccount(itemType: string, account: string): boolean {
  if (!/^\d{4}$/.test(account)) return false
  const rule = lineAccountOverride(itemType)
  if (rule === 'none') return false
  return rule === 'any' || account.startsWith('7')
}
