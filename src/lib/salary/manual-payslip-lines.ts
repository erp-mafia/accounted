/**
 * One-off payslip lines entered by hand ("Lägg till rad" on the payslip).
 *
 * The catalogue the UI offers. A row's flags and the sign of its deductions
 * come from its type (line-item-roles.ts), so a milersättning line entered by
 * hand is tax-free, outside the avgift base and outside the semester base
 * exactly like the one the körjournal would produce, and a bonus is a wage,
 * whichever door wrote it. Recalculation keeps these rows (run-calculation.ts
 * treats every non-derived line as manual).
 *
 * The calculated types are deliberately absent too (Övertid 50/100 %, the OB
 * tillägg and the absence rows, calculated-line-items.ts): every calculation
 * deletes and re-derives them from worked hours, premium rules and absence,
 * so a hand-entered one silently vanished from the pay (#3185). A one-off
 * övertid or OB amount goes on Övertid or Övrigt, which carry the same flags
 * and account; the line commands refuse the calculated types from every door.
 *
 * Textrad is a row of words only (text-rows.ts): no amount, no quantity, no
 * flags. It explains the payslip and never reaches the pay.
 *
 * Kostförmån and Övrig förmån are the benefits offered here (crm#1349):
 * meals that vary month to month (late dinners at the office), or a one-off
 * benefit, cannot sit on the employee as a fixed monthly value. The row is
 * the same benefit_meals / benefit_other row the employee's standing benefit
 * derives, so the engine taxes it and puts it in the avgiftsunderlag without
 * paying it out, the verifikat books no line for it (salary-entries.ts), and
 * the AGI reports it in FK012 with the other benefits, all by type
 * (benefit-payments.ts). A kostförmån is entered per måltid: the dialog
 * prices the chosen meal at Skatteverket's schablon for the run's year,
 * read from the payroll config the calculation froze on the run
 * (mealBenefitSchablonFromRunParams), so the values have one source.
 * Bilförmån, bostad, cykel and friskvård stay on the employee: they are
 * standing monthly values with their own valuation rules.
 *
 * Utlägg are deliberately absent: an expense claim reaches the payslip
 * through "Lägg till utlägg" on the run page, linked to the claim
 * (expense-claim-lines.ts), so it is settled when the run is booked. A free
 * expense_reimbursement row would credit 2820 with no claim behind it.
 *
 * Semester records vacation days taken (crm#1331): quantity is the days off,
 * which the vacation ledger counts (vacation-ledger.ts, converted to paid days
 * at fewer than five workdays a week), and vacation_category says which days
 * they are. It is not a calculated type: no absence register writes it, so
 * the operator enters it here, as through the API. Days without an amount
 * are priced by the calculation (lib/salary/vacation-days-pay.ts, #85): the
 * semestertillägg under sammalöneregeln, the semesterlöneavdrag and the
 * semesterlön under procentregeln, a deduction for obetalda dagar, each on a
 * row of its own. Quantity x à-pris or an amount on the line replaces that:
 * the line is then paid as entered, with its sign.
 *
 * Utlandstraktamente and nattraktamente (crm#1468, PH 218) are variants of
 * the traktamente rows, not item types of their own: the tax treatment, the
 * AGI (FK051 kryss, the taxable part in the gross) and Fora are the same, so
 * the row is stored as traktamente_taxfree / traktamente_taxable and only
 * the cap and the account differ. A foreign row books on 7323 / 7324
 * (Skattefria / Skattepliktiga traktamenten, utlandet; swedish-payroll
 * references/bas-7xxx.md) through account_number, the override every pay
 * row already carries. Skatteverket's normalbelopp per country is not in
 * the payroll config, so the operator enters the country and its
 * normalbelopp and the tax-free à-pris is capped at it; the excess goes on
 * the taxable foreign row, as on the domestic one. Nattraktamente is capped
 * at the year's traktamente_natt. Logi against a receipt is an utlägg (the
 * receipt is the company's verifikation, its moms is deducted there), so it
 * reaches the payslip through "Lägg till utlägg", not as a row here.
 */
import { roundOre } from '@/lib/money'
import type { SalaryLineItemType } from '@/types'
import { isDeductionLineType, payslipLineFlags } from '@/lib/salary/line-item-roles'
import { TEXT_ROW_MAX_LENGTH, VACATION_ITEM_TYPE, isTextRow, normalizeTextRow } from '@/lib/salary/text-rows'
import type { VacationCategory } from '@/lib/salary/vacation-category'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'

export type ManualPayslipLineType =
  | 'mileage_taxfree'
  | 'mileage_taxable'
  | 'traktamente_taxfree'
  | 'traktamente_taxable'
  | 'traktamente_night_taxfree'
  | 'traktamente_foreign_taxfree'
  | 'traktamente_foreign_taxable'
  | 'bonus'
  | 'commission'
  | 'overtime'
  | 'other'
  | 'correction'
  | 'benefit_meals'
  | 'benefit_other'
  | 'gross_deduction_other'
  | 'net_deduction_advance'
  | 'net_deduction_other'
  | 'vacation'
  | 'text'

export interface ManualLineSpec {
  /** Swedish default description written to the row (stored data stays Swedish). */
  label: string
  /** Keeps the sign typed: a correction or a semesterlöneavdrag can go either way. Any other amount is entered as a magnitude. */
  typedSign?: true
  /** What "Antal" counts, when the type is naturally quantity x price. */
  unit?: 'mil' | 'dagar' | 'natter' | 'timmar' | 'maltider'
  /** The item type the row is stored as, when the entry is a variant of another type (default: the key). */
  storedAs?: SalaryLineItemType
  /** The account written to the row's account_number (default: none, the booking resolves it). */
  account?: string
  /** A foreign traktamente: the operator names the country and enters its normalbelopp. */
  foreign?: boolean
}

/** In the order the dialog lists them: reimbursements, extra pay, benefits, deductions. */
export const MANUAL_PAYSLIP_LINE_SPECS: Record<ManualPayslipLineType, ManualLineSpec> = {
  mileage_taxfree: { label: 'Milersättning (skattefri)', unit: 'mil' },
  mileage_taxable: { label: 'Milersättning (skattepliktig)', unit: 'mil' },
  traktamente_taxfree: { label: 'Traktamente (skattefritt)', unit: 'dagar' },
  traktamente_taxable: { label: 'Traktamente (skattepliktigt)', unit: 'dagar' },
  traktamente_night_taxfree: {
    label: 'Nattraktamente (skattefritt)',
    unit: 'natter',
    storedAs: 'traktamente_taxfree',
  },
  traktamente_foreign_taxfree: {
    label: 'Utlandstraktamente (skattefritt)',
    unit: 'dagar',
    storedAs: 'traktamente_taxfree',
    account: resolveAccountRole(PINNED_JURISDICTION, 'foreign_per_diem_tax_free'),
    foreign: true,
  },
  traktamente_foreign_taxable: {
    label: 'Utlandstraktamente (skattepliktigt)',
    unit: 'dagar',
    storedAs: 'traktamente_taxable',
    account: resolveAccountRole(PINNED_JURISDICTION, 'foreign_per_diem_taxable'),
    foreign: true,
  },
  bonus: { label: 'Bonus' },
  commission: { label: 'Provision' },
  overtime: { label: 'Övertid', unit: 'timmar' },
  other: { label: 'Övrigt' },
  correction: { label: 'Korrigering', typedSign: true },
  benefit_meals: { label: 'Kostförmån', unit: 'maltider' },
  benefit_other: { label: 'Övrig förmån' },
  gross_deduction_other: { label: 'Bruttolöneavdrag' },
  net_deduction_advance: { label: 'Avdrag förskott' },
  net_deduction_other: { label: 'Nettolöneavdrag' },
  vacation: { label: 'Semester', typedSign: true, unit: 'dagar' },
  text: { label: 'Textrad' },
}

export const MANUAL_PAYSLIP_LINE_TYPES = Object.keys(MANUAL_PAYSLIP_LINE_SPECS) as ManualPayslipLineType[]

export function isManualPayslipLineType(type: string): type is ManualPayslipLineType {
  return Object.prototype.hasOwnProperty.call(MANUAL_PAYSLIP_LINE_SPECS, type)
}

/** The item type a catalogue entry is stored as (a variant names its base type). */
export function storedLineItemType(type: ManualPayslipLineType): SalaryLineItemType {
  return MANUAL_PAYSLIP_LINE_SPECS[type].storedAs ?? (type as SalaryLineItemType)
}

/** The entry whose row takes the part above a tax-free entry's cap. */
export function taxableCounterpart(type: ManualPayslipLineType): ManualPayslipLineType {
  if (type === 'mileage_taxfree') return 'mileage_taxable'
  if (type === 'traktamente_foreign_taxfree') return 'traktamente_foreign_taxable'
  return 'traktamente_taxable'
}

/**
 * Which meal a kostförmån row prices (swedish-payroll references/benefits.md,
 * Kostförmån): lunch eller middag and frukost per måltid, helt fri kost (at
 * least three meals) per dag. Lunch or dinner first: the common case.
 */
export const MEAL_BENEFIT_KINDS = ['lunch_middag', 'frukost', 'heldag'] as const
export type MealBenefitKind = (typeof MEAL_BENEFIT_KINDS)[number]

/** Swedish default description per meal (stored data stays Swedish). */
const MEAL_BENEFIT_DESCRIPTIONS: Record<MealBenefitKind, string> = {
  lunch_middag: 'Kostförmån, lunch eller middag',
  frukost: 'Kostförmån, frukost',
  heldag: 'Kostförmån, helt fri kost',
}

/** What "Antal" counts for the meal: måltider, or days of helt fri kost. */
export function mealBenefitUnit(kind: MealBenefitKind): 'maltider' | 'dagar' {
  return kind === 'heldag' ? 'dagar' : 'maltider'
}

export interface MealBenefitSchablon {
  /** The income year the values are for (the run's payroll config year). */
  year?: number
  perKind: Partial<Record<MealBenefitKind, number>>
}

/**
 * Skatteverket's förmånsvärde per meal for the run's year, read from the
 * payroll config the calculation stored on the run (salary_payroll_config
 * kostforman_lunch / kostforman_frukost / kostforman_heldag, serialised as
 * camelCase; the snake_case row shape is accepted too). Nothing here restates
 * the amounts. Empty when the run has not been calculated: the operator then
 * types the à-pris.
 */
export function mealBenefitSchablonFromRunParams(params: Record<string, unknown> | null | undefined): MealBenefitSchablon {
  if (!params) return { perKind: {} }
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = params[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    }
    return undefined
  }
  const perKind: Partial<Record<MealBenefitKind, number>> = {}
  const lunch = num('kostformanLunch', 'kostforman_lunch')
  const breakfast = num('kostformanFrukost', 'kostforman_frukost')
  const fullDay = num('kostformanHeldag', 'kostforman_heldag')
  if (lunch !== undefined) perKind.lunch_middag = lunch
  if (breakfast !== undefined) perKind.frukost = breakfast
  if (fullDay !== undefined) perKind.heldag = fullDay
  const year = num('configYear', 'config_year')
  return year !== undefined ? { year, perKind } : { perKind }
}

export interface ManualLineInput {
  item_type: ManualPayslipLineType
  /** Empty = the type's Swedish label (a kostförmån: its meal's description). */
  description?: string | null
  quantity?: number | null
  unit_price?: number | null
  /** Ignored when quantity and unit_price are both given. */
  amount?: number | null
  /** Vacation line only: which days are taken (vacation-category.ts). */
  vacation_category?: VacationCategory | null
  /** Kostförmån only: which meal the row prices; names the default description. */
  meal_kind?: MealBenefitKind | null
  /** Utlandstraktamente only: the country of the trip; names the default description. */
  country?: string | null
  /** Utlandstraktamente only: Skatteverket's normalbelopp per day for the country, the tax-free cap. */
  normalbelopp?: number | null
}

export interface ManualLineBody {
  item_type: SalaryLineItemType
  description: string
  quantity?: number
  unit_price?: number
  amount: number
  vacation_category?: VacationCategory
  /** A variant's own account (utlandstraktamente 7323 / 7324); a typed override replaces it. */
  account_number?: string
}

/**
 * Skatteverket's tax-free schablon per unit for the year of the run
 * (payroll_config: milersattning_egen_bil per mil, traktamente_heldag per
 * day, traktamente_natt per night). A tax-free line priced above it is simply taxable pay and is
 * refused; the excess belongs on the "skattepliktig" row. Absent = not
 * checked (the run has not been calculated yet, so its year's config is
 * not on the run).
 */
export interface ManualLineCaps {
  mileage_taxfree?: number
  traktamente_taxfree?: number
  traktamente_night_taxfree?: number
}

export type ManualLineBuild =
  | { ok: true; body: ManualLineBody }
  | { ok: false; reason: 'no_amount' }
  | { ok: false; reason: 'no_text' }
  | { ok: false; reason: 'no_days' }
  | { ok: false; reason: 'no_country' }
  | { ok: false; reason: 'no_normalbelopp' }
  | { ok: false; reason: 'above_tax_free_cap'; cap: number; unit: 'mil' | 'dagar' | 'natter' }

/**
 * The request body for POST /api/salary/runs/{id}/lines (minus the
 * salary_run_employee_id). The magnitude comes from quantity x unit_price
 * when both are given, else from amount; deductions are stored negative,
 * additions positive, a correction keeps the sign typed. Refuses a zero or
 * missing amount, and a tax-free reimbursement priced above its schablon.
 * A text row takes only its words (normalised, at most TEXT_ROW_MAX_LENGTH
 * characters); quantity, unit price and amount are ignored. A vacation line
 * needs its days; its amount is optional (buildVacationLine). A tax-free
 * utlandstraktamente needs its country and normalbelopp (the cap), a
 * taxable one its country.
 */
export function buildManualPayslipLine(input: ManualLineInput, caps: ManualLineCaps = {}): ManualLineBuild {
  const spec = MANUAL_PAYSLIP_LINE_SPECS[input.item_type]
  if (!spec) return { ok: false, reason: 'no_amount' }
  if (isTextRow(input)) {
    const text = normalizeTextRow(input.description ?? '')
    if (text === '' || text.length > TEXT_ROW_MAX_LENGTH) return { ok: false, reason: 'no_text' }
    return { ok: true, body: { item_type: storedLineItemType(input.item_type), description: text, amount: 0 } }
  }
  if (input.item_type === VACATION_ITEM_TYPE) return buildVacationLine(input, spec)
  const storedType = storedLineItemType(input.item_type)
  const quantity = finite(input.quantity)
  const unitPrice = finite(input.unit_price)
  const typed = finite(input.amount)
  const raw = quantity !== undefined && unitPrice !== undefined ? quantity * unitPrice : typed
  if (raw === undefined) return { ok: false, reason: 'no_amount' }
  const magnitude = roundOre(Math.abs(raw))
  if (magnitude === 0) return { ok: false, reason: 'no_amount' }

  const country = spec.foreign ? (input.country ?? '').trim() : ''
  if (spec.foreign && country === '') return { ok: false, reason: 'no_country' }
  const normalbelopp = finite(input.normalbelopp)
  const taxFreeForeign = spec.foreign === true && !payslipLineFlags(storedType).is_taxable
  if (taxFreeForeign && (normalbelopp === undefined || normalbelopp <= 0)) {
    return { ok: false, reason: 'no_normalbelopp' }
  }

  // A foreign row is capped at the normalbelopp the operator entered; the
  // taxable foreign row has no cap, like the domestic one.
  const cap = spec.foreign ? (taxFreeForeign ? normalbelopp : undefined) : capFor(input.item_type, caps)
  if (cap !== undefined && spec.unit && (spec.unit === 'mil' || spec.unit === 'dagar' || spec.unit === 'natter')) {
    // Price per unit: the typed à-pris, or amount over quantity when only the
    // quantity is known. An amount alone cannot be judged and passes.
    const perUnit =
      unitPrice !== undefined ? unitPrice : quantity !== undefined && quantity > 0 ? magnitude / quantity : undefined
    if (perUnit !== undefined && perUnit > cap + 1e-9) {
      return { ok: false, reason: 'above_tax_free_cap', cap, unit: spec.unit }
    }
  }

  const amount = isDeductionLineType(storedType) ? -magnitude : spec.typedSign ? roundOre(raw) : magnitude
  const description =
    (input.description ?? '').trim() || (spec.foreign ? `${spec.label}, ${country}` : defaultDescription(input, spec))
  const body: ManualLineBody = { item_type: storedType, description, amount }
  if (quantity !== undefined) body.quantity = quantity
  if (unitPrice !== undefined) body.unit_price = unitPrice
  if (spec.account) body.account_number = spec.account
  return { ok: true, body }
}

/**
 * A vacation line: the days taken in quantity (required, above 0) and,
 * optionally, what this payslip pays or deducts for them as quantity x
 * à-pris or an amount, kept with the sign typed (a semestertillägg is
 * positive, a semesterlöneavdrag negative). The days alone are stored at
 * 0 kr, the shape validatePayslipLineContent accepts from every door, and
 * the calculation prices them (vacation-days-pay.ts).
 */
function buildVacationLine(input: ManualLineInput, spec: ManualLineSpec): ManualLineBuild {
  const quantity = finite(input.quantity)
  if (quantity === undefined || quantity <= 0) return { ok: false, reason: 'no_days' }
  const unitPrice = finite(input.unit_price)
  const amount = roundOre(unitPrice !== undefined ? quantity * unitPrice : (finite(input.amount) ?? 0))
  const body: ManualLineBody = {
    item_type: VACATION_ITEM_TYPE,
    description: (input.description ?? '').trim() || spec.label,
    quantity,
    // A typed -0,001 rounds to -0: store a plain 0.
    amount: amount === 0 ? 0 : amount,
  }
  if (unitPrice !== undefined) body.unit_price = unitPrice
  if (input.vacation_category) body.vacation_category = input.vacation_category
  return { ok: true, body }
}

function defaultDescription(input: ManualLineInput, spec: ManualLineSpec): string {
  if (input.item_type === 'benefit_meals' && input.meal_kind && MEAL_BENEFIT_DESCRIPTIONS[input.meal_kind]) {
    return MEAL_BENEFIT_DESCRIPTIONS[input.meal_kind]
  }
  return spec.label
}

function capFor(type: ManualPayslipLineType, caps: ManualLineCaps): number | undefined {
  const cap =
    type === 'mileage_taxfree'
      ? caps.mileage_taxfree
      : type === 'traktamente_taxfree'
        ? caps.traktamente_taxfree
        : type === 'traktamente_night_taxfree'
          ? caps.traktamente_night_taxfree
          : undefined
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
  const night = num('traktamente_natt', 'traktamenteNatt')
  if (mil !== undefined) caps.mileage_taxfree = mil
  if (day !== undefined) caps.traktamente_taxfree = day
  if (night !== undefined) caps.traktamente_night_taxfree = night
  return caps
}

function finite(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
