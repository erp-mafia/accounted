/**
 * The pay Fora is told about: "kontant utbetald bruttolön", all pay before
 * tax paid out in the month (Fora, "Beräkna kontant utbetald bruttolön",
 * fora.se/for-leverantorer-av-lonesystem/berakna-kontant-utbetald-bruttolon).
 *
 * It is the engine's bruttolön (salary_run_employees.gross_salary) minus
 * the taxable rows Fora leaves out. Starting from the stored gross keeps one
 * definition of what a payslip pays: the absence valuation, semesterersättning
 * and the rest are the engine's, never recomputed here. Fora's list differs
 * from the bruttolön on two row types, both taxable cash the engine counts as
 * additions:
 *   - skattepliktiga traktamenten (Fora excludes taxable and tax-free alike);
 *   - bilersättning (mileage paid above the tax-free amount).
 * Förmåner, kostnadsersättningar and nettolöneavdrag are never in the
 * bruttolön, so there is nothing to take out for them.
 *
 * Bruttolöneavdrag (löneväxling, gross_deduction_*) lower the bruttolön and
 * stay lowered here: the cash actually paid out, the literal reading of
 * "kontant utbetald". Fora's list does not name them; see the MR for the
 * open question.
 *
 * FORA_PAY_TREATMENT is exhaustive over the row types, so a new item_type
 * fails the typecheck until someone decides where Fora stands on it.
 */
import type { SalaryLineItemType } from '@/types'
import { roundOre, sumOre } from '@/lib/money'

/**
 * - counted: part of the bruttolön, and of Fora's figure.
 * - excluded: part of the bruttolön when taxable, outside Fora's figure.
 * - outside_gross: never part of the bruttolön (förmån, kostnadsersättning,
 *   nettolöneavdrag, öresavrundning, text).
 */
export type ForaPayTreatment = 'counted' | 'excluded' | 'outside_gross'

export const FORA_PAY_TREATMENT: Record<SalaryLineItemType, ForaPayTreatment> = {
  // Lön, övertidsersättning, ersättning för obekväm arbetstid.
  monthly_salary: 'counted',
  hourly_salary: 'counted',
  overtime: 'counted',
  overtime_50: 'counted',
  overtime_100: 'counted',
  ob_weekday_evening: 'counted',
  ob_weekend: 'counted',
  ob_night: 'counted',
  ob_holiday: 'counted',
  // Bonus and provision are in the paid month's figure. Attributing bonus to
  // the months it was earned (attributablePays) is not built yet.
  bonus: 'counted',
  commission: 'counted',
  // Lower the bruttolön; the paid-out cash is what is reported.
  gross_deduction_pension: 'counted',
  gross_deduction_other: 'counted',
  benefit_car: 'outside_gross',
  benefit_housing: 'outside_gross',
  benefit_meals: 'outside_gross',
  benefit_wellness: 'outside_gross',
  benefit_bike: 'outside_gross',
  benefit_other: 'outside_gross',
  // Sjuklön betald av arbetsgivaren; the signed absence rows are the salary
  // the absence takes away, so the bruttolön is what was actually paid.
  sick_karens: 'counted',
  sick_day2_14: 'counted',
  sick_day15_plus: 'counted',
  vab: 'counted',
  parental_leave: 'counted',
  unpaid_leave: 'counted',
  // Semesterlön, semesterersättning.
  vacation: 'counted',
  semesterersattning: 'counted',
  traktamente_taxfree: 'outside_gross',
  traktamente_taxable: 'excluded',
  mileage_taxfree: 'outside_gross',
  mileage_taxable: 'excluded',
  expense_reimbursement: 'outside_gross',
  net_deduction_advance: 'outside_gross',
  net_deduction_union: 'outside_gross',
  net_deduction_benefit_payment: 'outside_gross',
  net_deduction_other: 'outside_gross',
  oresavrundning: 'outside_gross',
  // Retroactive pay is reported in the month it is paid out.
  correction: 'counted',
  other: 'counted',
  text: 'outside_gross',
}

/** The stored payslip row fields the rule reads (salary_line_items). */
export interface ForaPayLine {
  item_type: string
  amount: number | string
  is_taxable: boolean | null
  is_gross_deduction: boolean | null
  is_net_deduction: boolean | null
}

/**
 * Fora's figure for one payslip, in SEK with öre: the bruttolön minus the
 * excluded rows the engine summed into it (taxable, neither a gross nor a net
 * deduction: the engine's own addition filter).
 */
export function foraPayAmount(grossSalary: number | string, lines: readonly ForaPayLine[]): number {
  const excluded = lines.filter(
    (line) =>
      FORA_PAY_TREATMENT[line.item_type as SalaryLineItemType] === 'excluded' &&
      line.is_taxable === true &&
      line.is_gross_deduction !== true &&
      line.is_net_deduction !== true,
  )
  return roundOre(Number(grossSalary) - sumOre(excluded.map((line) => Number(line.amount))))
}
