import { roundOre } from '@/lib/money'
import type { SalaryLineItemType } from '@/types'

/**
 * The one definition of "taxable förmånsvärde after the employee's own
 * payment". The calculation engine (tax base, avgifter basis), the AGI
 * generator (FK012/FK013/FK015) and the KU route all read it, so the three
 * can never disagree about what a benefit is worth.
 *
 * Rule (swedish-payroll skill, references/deductions-lonevaxling.md): a
 * nettolöneavdrag "DOES reduce the taxable förmånsvärde if the deduction
 * constitutes payment for a specific benefit", and the processing order is
 * "Calculate förmånsvärden (reduced by nettolöneavdrag if applicable)" BEFORE
 * the tax base. references/benefits.md: "If the employee pays >= schablonvärde
 * via nettolöneavdrag, no taxable benefit arises."
 *
 * "For a specific benefit" is the load-bearing phrase. The payment line type
 * carries no link to a benefit, and the AGI reports each benefit type in its
 * own field, so:
 *   - one benefit type on the payslip: the payment can only be for that
 *     benefit. Reduce it, never below zero.
 *   - two or more benefit types: which one the payment is for is unknowable
 *     from the payslip. Refuse rather than guess: a guess is a silently wrong
 *     AGI. Linking a payment to a benefit type needs a schema change
 *     (DECISIONS.md 2026-08-03) and lifts this refusal when it lands.
 *
 * Pure: a function of the line set only. Nothing is persisted, so "Räkna om"
 * cannot apply the reduction twice.
 */

export const BENEFIT_ITEM_TYPES = [
  'benefit_car',
  'benefit_housing',
  'benefit_meals',
  'benefit_wellness',
  'benefit_bike',
  'benefit_other',
] as const satisfies readonly SalaryLineItemType[]

export type BenefitItemType = (typeof BENEFIT_ITEM_TYPES)[number]

// Compile-time guard: every `benefit_*` member of SalaryLineItemType must be in
// the list above. A benefit type added to the union later (a fuel benefit, say)
// fails the build here instead of silently escaping the reduction, the AGI and
// the KU. It adds no type today.
type MissingBenefitType = Exclude<Extract<SalaryLineItemType, `benefit_${string}`>, BenefitItemType>
const _everyBenefitTypeIsListed: [MissingBenefitType] extends [never] ? true : never = true
void _everyBenefitTypeIsListed

export const BENEFIT_PAYMENT_ITEM_TYPE = 'net_deduction_benefit_payment' satisfies SalaryLineItemType

export function isBenefitItemType(itemType: string): itemType is BenefitItemType {
  return (BENEFIT_ITEM_TYPES as readonly string[]).includes(itemType)
}

const BENEFIT_LABELS: Record<BenefitItemType, string> = {
  benefit_car: 'bilförmån',
  benefit_housing: 'bostadsförmån',
  benefit_meals: 'kostförmån',
  benefit_wellness: 'friskvård',
  benefit_bike: 'cykelförmån',
  benefit_other: 'övrig förmån',
}

export interface BenefitLine {
  itemType: string
  amount: number
}

export interface TaxableBenefits {
  /** Förmånsvärde per type as entered, before the employee's payment. */
  grossByType: Partial<Record<BenefitItemType, number>>
  /** Taxable förmånsvärde per type after the payment. Never negative for the reduced type. */
  taxableByType: Partial<Record<BenefitItemType, number>>
  grossTotal: number
  /** What the employee paid for the benefit this period, as a positive amount. */
  paid: number
  /** How much of `paid` actually lowered a förmånsvärde (capped at the benefit). */
  reduction: number
  /** The benefit type the reduction was taken from; null when nothing was reduced. */
  reducedType: BenefitItemType | null
  taxableTotal: number
}

export type TaxableBenefitsResult =
  | { ok: true; benefits: TaxableBenefits }
  | { ok: false; error: string }

// The shared helper rather than a hand-rolled round: the repo ratchet
// (check:guards, naive-ore-round) keeps one. For sums of öre-precision amounts
// it agrees exactly with the engine's own rounding; benefit-payment.test.ts
// pins that.
const r = roundOre
const ore = (x: number) => Math.round(Math.abs(x) * 100)

/** Display only (warning text): absolute amount, öre kept when present. Not money math. */
export function formatKronor(amount: number): string {
  return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(
    Math.abs(amount),
  )
}

/**
 * Explicit bruttolöneavdrag rows. Keyed on item type, not on the
 * is_gross_deduction flag: derived sick/VAB/parental rows carry that flag too.
 */
const GROSS_DEDUCTION_ITEM_TYPES: readonly string[] = ['gross_deduction_pension', 'gross_deduction_other']

/**
 * Bruttolöneavdrag rows that look like a hand-made version of the reduction
 * this module now applies.
 *
 * Before the engine knew the rule, the only way to stop a fully paid benefit
 * from being taxed was to add a bruttolöneavdrag of the same amount next to
 * the payment. It got the tax base right and the cash wrong. With the
 * reduction built in, the same row lowers the tax base a SECOND time, so tax
 * and arbetsgivaravgifter come out too low by the benefit amount.
 *
 * A match is a gross deduction equal, to the öre, to the reduction or to one
 * of the payment rows. That is a strong signal and not proof: a real
 * bruttolöneavdrag of the same amount is legitimate and indistinguishable in
 * the data. Hence callers WARN and never refuse or auto-remove.
 */
export function findDoubleBenefitAdjustments<T extends BenefitLine>(
  lines: readonly T[],
  benefits: TaxableBenefits,
): T[] {
  if (benefits.reduction <= 0) return []
  const suspectOre = new Set<number>([ore(benefits.reduction)])
  for (const li of lines) {
    if (li.itemType === BENEFIT_PAYMENT_ITEM_TYPE && li.amount < 0) suspectOre.add(ore(li.amount))
  }
  return lines.filter(
    (li) => GROSS_DEDUCTION_ITEM_TYPES.includes(li.itemType) && li.amount < 0 && suspectOre.has(ore(li.amount)),
  )
}

/** A payslip row with what the warning needs to name it and say where it is removed. */
export interface DescribedLine extends BenefitLine {
  description: string
  /** Derived from employee_recurring_lines: it comes back every month until removed there. */
  fromRecurringLine: boolean
}

/**
 * The payslip's rows as the warning sees them: hand-entered rows from the
 * stored set plus the recurring rows just derived from the register. Stored
 * rows with a register back-link are skipped, the fresh derivation replaces
 * them (run-calculation steps 8d and 8d3).
 */
export function collectDescribedLines(
  storedRows: ReadonlyArray<Record<string, unknown>>,
  derivedRecurringRows: ReadonlyArray<{ item_type: string; amount: number; description?: string | null }>,
): DescribedLine[] {
  return [
    ...storedRows
      .filter((li) => !li.source_benefit_id && !li.source_recurring_line_id)
      .map((li) => ({
        itemType: li.item_type as string,
        amount: li.amount as number,
        description: (li.description as string | null) ?? '',
        fromRecurringLine: false,
      })),
    ...derivedRecurringRows.map((row) => ({
      itemType: row.item_type,
      amount: row.amount,
      description: row.description ?? '',
      fromRecurringLine: true,
    })),
  ]
}

/** One entry per suspect row, naming the employee, the row and where it is removed. */
export function describeDoubleBenefitAdjustments(
  employeeName: string,
  lines: readonly DescribedLine[],
  benefits: TaxableBenefits,
): string[] {
  return findDoubleBenefitAdjustments(lines, benefits).map(
    (suspect) =>
      `${employeeName}: bruttolöneavdraget "${suspect.description}" (${formatKronor(suspect.amount)} kr) ` +
      (suspect.fromRecurringLine
        ? 'tas bort under Återkommande lönerader på den anställde'
        : 'tas bort på lönebeskedet'),
  )
}

/** The run-level warning, or null when no payslip carries a suspect row. */
export function doubleBenefitAdjustmentWarning(entries: readonly string[]): string | null {
  if (entries.length === 0) return null
  return (
    'Förmånsvärdet sätts nu ned automatiskt med den anställdes nettolöneavdrag för förmånen. ' +
    'Ett bruttolöneavdrag med samma belopp ser ut att justera samma förmån en gång till, och då blir skatten och arbetsgivaravgifterna för låga. ' +
    'Ta bort raden och räkna om, om den inte är ett verkligt bruttolöneavdrag: ' +
    `${entries.join('; ')}.`
  )
}

/**
 * Why a declaration must not be built from this payslip, or null.
 *
 * The AGI and the KU take the förmånsvärde from the payslip ROWS, resolved
 * fresh, but the tax withheld and the avgifter underlag from the TOTALS stored
 * at calculation time. A payslip last calculated before the reduction existed
 * stores the unreduced förmånsvärde, so the document would declare a benefit
 * that disagrees with the tax actually withheld. One helper for both, so the
 * two documents cannot drift into different rules.
 *
 * Only a payslip with a reduction can differ, so no historical run without a
 * benefit payment is ever touched.
 */
export function staleBenefitTotalRefusal(args: {
  who: string
  periodYear: number
  periodMonth: number
  document: 'arbetsgivardeklarationen' | 'kontrolluppgiften'
  storedBenefitValues: number | null | undefined
  benefits: TaxableBenefits
}): string | null {
  const { benefits, storedBenefitValues } = args
  if (benefits.reduction <= 0) return null
  if (typeof storedBenefitValues !== 'number') return null
  if (ore(storedBenefitValues) === ore(benefits.taxableTotal)) return null
  const period = `${args.periodYear}-${String(args.periodMonth).padStart(2, '0')}`
  return (
    `${args.who}, ${period}: lönebeskedet har ett nettolöneavdrag för förmån men är beräknat innan förmånsvärdet sattes ned med betalningen, ` +
    'så avdragen skatt och underlag stämmer inte med förmånsvärdet. ' +
    `Räkna om lönekörningen (Tillbaka till utkast) eller, om den är bokförd, korrigera den (Korrigera lönekörning) innan ${args.document} skapas.`
  )
}

/**
 * The refusal as the calculate route returns it. The issue is an OBJECT with
 * a message on purpose: the client (lib/errors/get-error-message.ts) renders
 * VALIDATION_ERROR issues only in that shape and drops a bare string, which
 * would leave the user with the generic "ogiltiga uppgifter" and no way out.
 * It also cuts a message at 500 characters, hence the terse wording above.
 */
export function benefitPaymentRefusalDetails(employeeName: string, error: string) {
  return {
    issues: [{ message: `${employeeName}: ${error}` }],
    reason: 'benefit_payment_ambiguous' as const,
  }
}

export function resolveTaxableBenefits(lines: readonly BenefitLine[]): TaxableBenefitsResult {
  const benefitLines = lines.filter((li) => isBenefitItemType(li.itemType))
  // Same expression the engine has always used, so a payslip without a
  // payment produces a byte-identical total.
  const grossTotal = r(benefitLines.reduce((sum, li) => sum + li.amount, 0))

  const grossByType: Partial<Record<BenefitItemType, number>> = {}
  for (const li of benefitLines) {
    const type = li.itemType as BenefitItemType
    grossByType[type] = r((grossByType[type] ?? 0) + li.amount)
  }

  // Payslip deductions are negative. A positive row is a repayment TO the
  // employee and must never lower a förmånsvärde, hence no Math.abs.
  const paymentSum = lines
    .filter((li) => li.itemType === BENEFIT_PAYMENT_ITEM_TYPE)
    .reduce((sum, li) => sum + li.amount, 0)
  const paid = Math.max(0, r(-paymentSum))

  const unreduced: TaxableBenefits = {
    grossByType,
    taxableByType: { ...grossByType },
    grossTotal,
    paid,
    reduction: 0,
    reducedType: null,
    taxableTotal: grossTotal,
  }
  if (paid === 0) return { ok: true, benefits: unreduced }

  const payableTypes = BENEFIT_ITEM_TYPES.filter((type) => (grossByType[type] ?? 0) > 0)
  // A payment with no benefit on the payslip lowers nothing: plain net deduction.
  if (payableTypes.length === 0) return { ok: true, benefits: unreduced }

  if (payableTypes.length > 1) {
    const names = payableTypes.map((type) => BENEFIT_LABELS[type]).join(', ')
    return {
      ok: false,
      error:
        `Nettolöneavdraget för förmån kan inte kopplas till en bestämd förmån: lönebeskedet har flera förmånstyper (${names}). ` +
        'En betalning sänker bara värdet på den förmån den avser, och förmånerna redovisas i olika fält i arbetsgivardeklarationen. ' +
        'Behåll en förmånstyp, eller ta bort avdraget och ange förmånens värde efter betalning på förmånsraden.',
    }
  }

  const type = payableTypes[0]
  const gross = grossByType[type] ?? 0
  const reduction = r(Math.min(paid, gross))
  return {
    ok: true,
    benefits: {
      grossByType,
      taxableByType: { ...grossByType, [type]: r(gross - reduction) },
      grossTotal,
      paid,
      reduction,
      reducedType: reduction > 0 ? type : null,
      taxableTotal: r(grossTotal - reduction),
    },
  }
}
