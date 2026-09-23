import {
  findDoubleBenefitAdjustments,
  formatKronor,
  resolveTaxableBenefits,
} from './benefit-payments'

/**
 * Pure logic behind scripts/salary/recalculate-draft-run.ts: what the support
 * script refuses, and what it shows before anything is written. Kept out of
 * the script so it can be unit-tested; the script itself only does I/O.
 */

export interface RunForRecalculation {
  id: string
  company_id: string
  status: string
}

/**
 * Why this run must not be recalculated, or null when it may be.
 *
 * Draft only. Everything past draft has been reviewed, approved, paid or
 * booked on the stored totals: recalculating it would move numbers a person
 * signed off on, and for a booked run would part the payslip from its
 * verifikat. Those go back to draft in the product (revert) or through a
 * correction run, never through this script.
 */
export function recalculationRefusal(run: RunForRecalculation | null, companyId: string): string | null {
  if (!run) return 'No such salary run.'
  if (run.company_id !== companyId) return 'The salary run does not belong to the company given with --company.'
  if (run.status !== 'draft') {
    return `The salary run has status "${run.status}". Only a draft run is recalculated by this script.`
  }
  return null
}

export interface StoredPayslipRow {
  item_type: string
  description: string | null
  amount: number
  is_gross_deduction?: boolean | null
  source_benefit_id?: string | null
  source_recurring_line_id?: string | null
}

export interface PayslipInspection {
  /** Every explicit bruttolöneavdrag row, flagged or not: support reads these before --apply. */
  grossDeductions: StoredPayslipRow[]
  /**
   * Gross deductions equal to the öre to what the employee's benefit payment
   * takes off the förmånsvärde: the pre-fix workaround. Recalculating with
   * one in place lowers the tax base twice.
   */
  flagged: StoredPayslipRow[]
  /** Set when the payslip cannot be calculated at all (a payment next to several benefit types). */
  resolutionError: string | null
}

const GROSS_DEDUCTION_ITEM_TYPES = ['gross_deduction_pension', 'gross_deduction_other']

/**
 * Reads the STORED rows, which are what the last calculation produced. The
 * recalculation re-derives benefit and recurring rows from their registers,
 * so a register edited since then makes these rows stale: the script prints
 * the register next to them for that reason.
 */
export function inspectStoredPayslip(rows: readonly StoredPayslipRow[]): PayslipInspection {
  const grossDeductions = rows.filter((row) => GROSS_DEDUCTION_ITEM_TYPES.includes(row.item_type))
  const lines = rows.map((row) => ({ itemType: row.item_type, amount: row.amount, row }))
  const resolution = resolveTaxableBenefits(lines)
  if (!resolution.ok) return { grossDeductions, flagged: [], resolutionError: resolution.error }
  return {
    grossDeductions,
    flagged: findDoubleBenefitAdjustments(lines, resolution.benefits).map((line) => line.row),
    resolutionError: null,
  }
}

export const ACKNOWLEDGE_FLAG = '--acknowledge-gross-deduction'

/**
 * Why --apply must stop, or null. A flagged row is a strong signal, not
 * proof (a real bruttolöneavdrag of the same amount is legitimate), so it is
 * a stop that a person can lift after looking, never a silent pass.
 */
export function applyRefusal(flaggedCount: number, acknowledged: boolean): string | null {
  if (flaggedCount === 0 || acknowledged) return null
  return (
    `${flaggedCount} payslip row(s) look like the pre-fix workaround: a bruttolöneavdrag of exactly the amount the ` +
    "employee's benefit payment now takes off the förmånsvärde. Recalculating with it in place lowers the tax base " +
    'TWICE: tax and arbetsgivaravgifter come out too low by that amount. Have the customer remove the row ' +
    '(Återkommande lönerader on the employee, or the payslip) first. If it is a real bruttolöneavdrag, re-run with ' +
    `${ACKNOWLEDGE_FLAG}.`
  )
}

export function describeRow(row: StoredPayslipRow): string {
  const origin = row.source_recurring_line_id
    ? 'recurring line'
    : row.source_benefit_id
      ? 'benefit register'
      : 'hand-entered'
  const sign = row.amount < 0 ? '-' : ''
  return `${row.item_type.padEnd(32)} ${`${sign}${formatKronor(row.amount)}`.padStart(12)}  ${origin.padEnd(16)} ${row.description ?? ''}`
}
