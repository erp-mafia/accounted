/**
 * Förhöjt skatteavdrag: extra preliminary tax the employee asked for.
 *
 * SFL 11 kap. 22 §: when the person paid for work asks for it, the payer
 * "ska" make a higher deduction from the main income (huvudinkomsten), no
 * later than from the first payment two weeks after the request. No decision
 * from Skatteverket is needed. It is not allowed after Skatteverket has
 * revised the preliminary A-skatt at the request of Kronofogden or a
 * konkursbo; that cannot be seen from here, so the help text says it.
 *
 * Two forms on the employee row, at most one set (CHECK constraint
 * employees_extra_tax_one_form_check, migration 20261014234000):
 *   - extra_tax_amount: whole kronor on top of the statutory tax, every run;
 *   - extra_tax_percentage: a requested total, withhold the higher of the
 *     statutory tax and this share of the taxable income.
 *
 * The engine (calculation-engine.ts) adds the extra after the statutory tax,
 * in the table and jämkning branches only: the flat 30 % paths are
 * sidoinkomst or unverified tax status, never a main income, and F-skatt has
 * no withholding. The extra is capped at the cash pay left after the
 * statutory tax and the net deductions, so it never comes out of tax-free
 * reimbursements. It lands in tax_withheld, so the booking (2710), AGI field
 * 001, the payslip, the year-to-date totals and the bank file follow.
 *
 * Pure (no server imports): the employee form uses extraTaxPatch client-side.
 */

import { roundOre, truncateToWholeKronor, wholeKronaPercentage } from '@/lib/money'
import { isJamkningEditable } from './jamkning-patch'

export const EXTRA_TAX_FIELDS = ['extra_tax_amount', 'extra_tax_percentage'] as const

export interface ExtraTaxFields {
  extra_tax_amount?: number | null
  extra_tax_percentage?: number | null
}

export interface ExtraTaxIssue {
  field: 'extra_tax_amount' | 'extra_tax_percentage'
  message: string
}

export const EXTRA_TAX_ONE_FORM =
  'Extra skatteavdrag anges antingen i kronor eller i procent, inte båda. Töm det ena fältet'
export const EXTRA_TAX_AMOUNT_RANGE = 'Extra skatteavdrag i kronor anges i hela kronor, från 1 till 1 000 000'
export const EXTRA_TAX_PERCENTAGE_RANGE =
  'Extra skatteavdrag i procent måste vara över 0 och högst 100, med högst två decimaler'

/** Upper bound of extra_tax_amount (CHECK constraint, migration 20261014234000). */
export const EXTRA_TAX_AMOUNT_MAX = 1_000_000

/** Over 0, at most 100, and storable in numeric(5,2) without silent rounding. */
export function isStorableExtraTaxPercentage(value: number): boolean {
  return value > 0 && value <= 100 && roundOre(value) === value
}

/** Issues with the MERGED row (existing row + patch, or the full create body). */
export function validateExtraTax(fields: ExtraTaxFields): ExtraTaxIssue[] {
  const hasAmount = fields.extra_tax_amount !== null && fields.extra_tax_amount !== undefined
  const hasPercentage = fields.extra_tax_percentage !== null && fields.extra_tax_percentage !== undefined
  return hasAmount && hasPercentage ? [{ field: 'extra_tax_percentage', message: EXTRA_TAX_ONE_FORM }] : []
}

/** True when a sparse patch names either key (an explicit null counts). */
export function touchesExtraTax(patch: Record<string, unknown>): boolean {
  return EXTRA_TAX_FIELDS.some((key) => key in patch)
}

export const EXTRA_TAX_CHECK_CONSTRAINT = 'employees_extra_tax_one_form_check'

/**
 * The issue behind a rejection by employees_extra_tax_one_form_check, or null
 * for any other error. The merged-state check passed against a snapshot that
 * another request changed in between (one set kronor, the other a
 * percentage); the constraint is what refuses the second write.
 */
export function extraTaxIssueFromDbError(error: unknown): ExtraTaxIssue | null {
  if (typeof error !== 'object' || error === null) return null
  const { code, message, constraint } = error as { code?: unknown; message?: unknown; constraint?: unknown }
  if (code !== '23514') return null
  const named =
    constraint === EXTRA_TAX_CHECK_CONSTRAINT ||
    (typeof message === 'string' && message.includes(`"${EXTRA_TAX_CHECK_CONSTRAINT}"`))
  return named ? { field: 'extra_tax_percentage', message: EXTRA_TAX_ONE_FORM } : null
}

// ============================================================
// Calculation
// ============================================================

/** Which statutory branch the engine's Step 6 ran. */
export type StatutoryTaxBranch = 'f_skatt' | 'not_verified' | 'sidoinkomst' | 'jamkning' | 'table' | 'fallback'

export interface ExtraTaxInput {
  amount: number | null | undefined
  percentage: number | null | undefined
  branch: StatutoryTaxBranch
  taxableIncome: number
  grossSalary: number
  netDeductions: number
  /** The statutory tax in whole kronor (table or jämkning, plus engångsskatt). */
  statutoryTax: number
}

export interface ExtraTaxStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

export interface ExtraTaxResult {
  extra: number
  /** The breakdown row; null when the employee asked for nothing. */
  step: ExtraTaxStep | null
}

export const EXTRA_TAX_STEP_LABEL = 'Extra skatteavdrag (begärt)'

const NOT_APPLIED_REASON: Record<Exclude<StatutoryTaxBranch, 'jamkning' | 'table'>, string> = {
  f_skatt: 'F-skatt, inget skatteavdrag görs',
  not_verified: 'skattsedeln är inte verifierad, 30 % dras',
  sidoinkomst: 'sidoinkomst, förhöjt avdrag görs bara från huvudinkomsten',
  fallback: 'ingen skattetabell, 30 % dras',
}

function kr(amount: number): string {
  return `${Math.round(amount).toLocaleString('sv-SE')} kr`
}

/**
 * The extra on top of the statutory tax, and the breakdown row that explains
 * it. Whole kronor throughout: the requested amount is whole kronor, the
 * percentage target drops öre like every percentage tax (SFF 22 kap. 1 §),
 * and the cap is the cash left in whole kronor.
 */
export function computeExtraTax(input: ExtraTaxInput): ExtraTaxResult {
  const amount = input.amount ?? null
  const percentage = input.percentage ?? null
  if (amount === null && percentage === null) return { extra: 0, step: null }

  const requestInput: Record<string, number | string> =
    amount !== null ? { requested_amount: amount } : { requested_percentage: percentage as number }

  if (input.branch !== 'table' && input.branch !== 'jamkning') {
    return {
      extra: 0,
      step: {
        label: EXTRA_TAX_STEP_LABEL,
        formula: `tillämpas inte: ${NOT_APPLIED_REASON[input.branch]}`,
        input: requestInput,
        output: 0,
      },
    }
  }

  let requested: number
  let formula: string
  if (amount !== null) {
    requested = amount
    formula = `begärt belopp ${kr(amount)} per lön`
  } else {
    const target = wholeKronaPercentage(input.taxableIncome, percentage as number)
    requested = Math.max(0, target - input.statutoryTax)
    requestInput.target_tax = target
    formula =
      requested > 0
        ? `${percentage} % av skattegrundande inkomst (${kr(target)}) − skatteavdrag (${kr(input.statutoryTax)})`
        : `${percentage} % av skattegrundande inkomst (${kr(target)}) är inte mer än skatteavdraget (${kr(input.statutoryTax)})`
  }

  const cashLeft = truncateToWholeKronor(roundOre(input.grossSalary - input.netDeductions)) - input.statutoryTax
  const cap = Math.max(0, cashLeft)
  const extra = Math.min(requested, cap)
  if (extra < requested) {
    formula =
      cap > 0
        ? `${formula}, begränsat till kontant lön kvar efter skatt och nettoavdrag (${kr(cap)})`
        : `${formula}, ingen kontant lön kvar att dra från`
  }

  return {
    extra,
    step: {
      label: EXTRA_TAX_STEP_LABEL,
      formula,
      input: { ...requestInput, statutory_tax: input.statutoryTax, cash_left: cap },
      output: extra,
    },
  }
}

// ============================================================
// Employee form patch
// ============================================================

export interface ExtraTaxFormState {
  f_skatt_status: string
  is_sidoinkomst: boolean
  extra_tax_amount: number | null
  extra_tax_percentage: number | null
  /** True once the user edited the extra-tax inputs this session. */
  extra_tax_touched: boolean
}

export interface ExtraTaxPatch {
  extra_tax_amount: number | null
  extra_tax_percentage: number | null
}

/**
 * The two keys (explicit values, null = clear) when the inputs were visible
 * and edited; otherwise an empty object, so a stored request survives an
 * unrelated edit and a switch to F-skatt or sidoinkomst (the engine then
 * ignores it, and it applies again when the status is switched back). Same
 * rule as jamkningPatch: the inputs share its branch of the tax card.
 */
export function extraTaxPatch(state: ExtraTaxFormState): ExtraTaxPatch | Record<string, never> {
  if (!isJamkningEditable(state) || !state.extra_tax_touched) return {}
  return {
    extra_tax_amount: state.extra_tax_amount,
    extra_tax_percentage: state.extra_tax_percentage,
  }
}
