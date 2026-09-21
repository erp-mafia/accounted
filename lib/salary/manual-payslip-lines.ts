/**
 * One-off payslip lines entered by hand ("Lägg till rad" on the payslip).
 *
 * The line commands (payslip-lines.ts) accept any line type with any flags;
 * this module is the catalogue the UI offers and the flag set each type
 * carries, so a milersättning line entered by hand is tax-free, outside the
 * avgift base and outside the semester base exactly like the one the
 * körjournal would produce, and a bonus is a wage. Recalculation keeps these
 * rows (run-calculation.ts treats every non-derived line as manual).
 *
 * Utlägg are deliberately absent: an expense claim reaches the payslip
 * through "Lägg till utlägg" on the run page, linked to the claim
 * (expense-claim-lines.ts), so it is settled when the run is booked. A free
 * expense_reimbursement row would credit 2820 with no claim behind it.
 */
import { roundOre } from '@/lib/money'
import type { SalaryLineItemType } from '@/types'

export type ManualPayslipLineType =
  | 'mileage_taxfree'
  | 'mileage_taxable'
  | 'traktamente_taxfree'
  | 'traktamente_taxable'
  | 'bonus'
  | 'commission'
  | 'overtime'
  | 'overtime_50'
  | 'overtime_100'
  | 'ob_weekday_evening'
  | 'ob_weekend'
  | 'ob_night'
  | 'ob_holiday'
  | 'other'
  | 'correction'
  | 'gross_deduction_other'
  | 'net_deduction_advance'
  | 'net_deduction_other'

export interface ManualLineFlags {
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
}

/** How the entered magnitude is signed on the row. */
export type ManualLineSign = 'addition' | 'deduction' | 'signed'

export interface ManualLineSpec {
  /** Swedish default description written to the row (stored data stays Swedish). */
  label: string
  flags: ManualLineFlags
  sign: ManualLineSign
  /** What "Antal" counts, when the type is naturally quantity x price. */
  unit?: 'mil' | 'dagar' | 'timmar'
}

/** Kostnadsersättning at or under Skatteverket's schablon: net payout only. */
const TAX_FREE: ManualLineFlags = {
  is_taxable: false,
  is_avgift_basis: false,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
}
/** Kostnadsersättning above the schablon: taxed as salary, not semestergrundande. */
const TAXABLE_REIMBURSEMENT: ManualLineFlags = {
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
}
/** A wage: taxed, avgift basis, semestergrundande. */
const WAGE: ManualLineFlags = {
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
}
/** Same flags the recurring bruttolöneavdrag carries (recurring-lines.ts). */
const GROSS_DEDUCTION: ManualLineFlags = {
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: false,
  is_gross_deduction: true,
  is_net_deduction: false,
}
const NET_DEDUCTION: ManualLineFlags = {
  is_taxable: false,
  is_avgift_basis: false,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: true,
}

/** In the order the dialog lists them: reimbursements, extra pay, deductions. */
export const MANUAL_PAYSLIP_LINE_SPECS: Record<ManualPayslipLineType, ManualLineSpec> = {
  mileage_taxfree: { label: 'Milersättning (skattefri)', flags: TAX_FREE, sign: 'addition', unit: 'mil' },
  mileage_taxable: { label: 'Milersättning (skattepliktig)', flags: TAXABLE_REIMBURSEMENT, sign: 'addition', unit: 'mil' },
  traktamente_taxfree: { label: 'Traktamente (skattefritt)', flags: TAX_FREE, sign: 'addition', unit: 'dagar' },
  traktamente_taxable: { label: 'Traktamente (skattepliktigt)', flags: TAXABLE_REIMBURSEMENT, sign: 'addition', unit: 'dagar' },
  bonus: { label: 'Bonus', flags: WAGE, sign: 'addition' },
  commission: { label: 'Provision', flags: WAGE, sign: 'addition' },
  overtime: { label: 'Övertid', flags: WAGE, sign: 'addition', unit: 'timmar' },
  overtime_50: { label: 'Övertid 50 %', flags: WAGE, sign: 'addition', unit: 'timmar' },
  overtime_100: { label: 'Övertid 100 %', flags: WAGE, sign: 'addition', unit: 'timmar' },
  ob_weekday_evening: { label: 'OB-tillägg kväll', flags: WAGE, sign: 'addition', unit: 'timmar' },
  ob_weekend: { label: 'OB-tillägg helg', flags: WAGE, sign: 'addition', unit: 'timmar' },
  ob_night: { label: 'OB-tillägg natt', flags: WAGE, sign: 'addition', unit: 'timmar' },
  ob_holiday: { label: 'OB-tillägg storhelg', flags: WAGE, sign: 'addition', unit: 'timmar' },
  other: { label: 'Övrigt', flags: WAGE, sign: 'addition' },
  correction: { label: 'Korrigering', flags: WAGE, sign: 'signed' },
  gross_deduction_other: { label: 'Bruttolöneavdrag', flags: GROSS_DEDUCTION, sign: 'deduction' },
  net_deduction_advance: { label: 'Avdrag förskott', flags: NET_DEDUCTION, sign: 'deduction' },
  net_deduction_other: { label: 'Nettolöneavdrag', flags: NET_DEDUCTION, sign: 'deduction' },
}

export const MANUAL_PAYSLIP_LINE_TYPES = Object.keys(MANUAL_PAYSLIP_LINE_SPECS) as ManualPayslipLineType[]

export function isManualPayslipLineType(type: string): type is ManualPayslipLineType {
  return Object.prototype.hasOwnProperty.call(MANUAL_PAYSLIP_LINE_SPECS, type)
}

export interface ManualLineInput {
  item_type: ManualPayslipLineType
  /** Empty = the type's Swedish label. */
  description?: string | null
  quantity?: number | null
  unit_price?: number | null
  /** Ignored when quantity and unit_price are both given. */
  amount?: number | null
}

export interface ManualLineBody extends ManualLineFlags {
  item_type: SalaryLineItemType
  description: string
  quantity?: number
  unit_price?: number
  amount: number
}

/**
 * Skatteverket's tax-free schablon per unit for the year of the run
 * (payroll_config: milersattning_egen_bil per mil, traktamente_heldag per
 * day). A tax-free line priced above it is simply taxable pay and is
 * refused; the excess belongs on the "skattepliktig" row. Absent = not
 * checked (the run has not been calculated yet, so its year's config is
 * not on the run).
 */
export interface ManualLineCaps {
  mileage_taxfree?: number
  traktamente_taxfree?: number
}

export type ManualLineBuild =
  | { ok: true; body: ManualLineBody }
  | { ok: false; reason: 'no_amount' }
  | { ok: false; reason: 'above_tax_free_cap'; cap: number; unit: 'mil' | 'dagar' }

/**
 * The request body for POST /api/salary/runs/{id}/lines (minus the
 * salary_run_employee_id). The magnitude comes from quantity x unit_price
 * when both are given, else from amount; deductions are stored negative,
 * additions positive, a correction keeps the sign typed. Refuses a zero or
 * missing amount, and a tax-free reimbursement priced above its schablon.
 */
export function buildManualPayslipLine(input: ManualLineInput, caps: ManualLineCaps = {}): ManualLineBuild {
  const spec = MANUAL_PAYSLIP_LINE_SPECS[input.item_type]
  if (!spec) return { ok: false, reason: 'no_amount' }
  const quantity = finite(input.quantity)
  const unitPrice = finite(input.unit_price)
  const typed = finite(input.amount)
  const raw = quantity !== undefined && unitPrice !== undefined ? quantity * unitPrice : typed
  if (raw === undefined) return { ok: false, reason: 'no_amount' }
  const magnitude = roundOre(Math.abs(raw))
  if (magnitude === 0) return { ok: false, reason: 'no_amount' }

  const cap = capFor(input.item_type, caps)
  if (cap !== undefined && spec.unit && (spec.unit === 'mil' || spec.unit === 'dagar')) {
    // Price per unit: the typed à-pris, or amount over quantity when only the
    // quantity is known. An amount alone cannot be judged and passes.
    const perUnit =
      unitPrice !== undefined ? unitPrice : quantity !== undefined && quantity > 0 ? magnitude / quantity : undefined
    if (perUnit !== undefined && perUnit > cap + 1e-9) {
      return { ok: false, reason: 'above_tax_free_cap', cap, unit: spec.unit }
    }
  }

  const amount =
    spec.sign === 'deduction' ? -magnitude : spec.sign === 'addition' ? magnitude : roundOre(raw)
  const description = (input.description ?? '').trim() || spec.label
  const body: ManualLineBody = {
    item_type: input.item_type,
    description,
    amount,
    ...spec.flags,
  }
  if (quantity !== undefined) body.quantity = quantity
  if (unitPrice !== undefined) body.unit_price = unitPrice
  return { ok: true, body }
}

function capFor(type: ManualPayslipLineType, caps: ManualLineCaps): number | undefined {
  const cap =
    type === 'mileage_taxfree' ? caps.mileage_taxfree : type === 'traktamente_taxfree' ? caps.traktamente_taxfree : undefined
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined
}

/**
 * The caps for a run, read from the payroll config the calculation stored
 * on it (serializePayrollConfig writes the camelCase PayrollConfig fields;
 * the snake_case DB row shape is accepted too). Empty when the run has not
 * been calculated.
 */
export function manualLineCapsFromRunParams(params: Record<string, unknown> | null | undefined): ManualLineCaps {
  if (!params) return {}
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = params[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    }
    return undefined
  }
  const caps: ManualLineCaps = {}
  const mil = num('milersattning_egen_bil', 'milersattningEgenBil')
  const day = num('traktamente_heldag', 'traktamenteHeldag')
  if (mil !== undefined) caps.mileage_taxfree = mil
  if (day !== undefined) caps.traktamente_taxfree = day
  return caps
}

function finite(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
