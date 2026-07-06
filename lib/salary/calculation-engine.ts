import type { PayrollConfig } from './payroll-config'
import type { TaxTableRate } from './tax-tables'
import { lookupTaxAmount, calculateJamkningTax, calculateSidoinkomstTax } from './tax-tables'
import { calculateAgeAtYearStart, decryptPersonnummer } from './personnummer'
import type { SalaryLineItemType } from '@/types'

// ============================================================
// Types
// ============================================================

export interface SalaryCalculationInput {
  /** Employee data */
  employmentType: 'employee' | 'company_owner' | 'board_member'
  salaryType: 'monthly' | 'hourly'
  monthlySalary: number
  hourlyRate?: number
  hoursWorked?: number
  employmentDegree: number // 1-100

  /** Tax */
  taxTableNumber: number | null
  taxColumn: number
  isSidoinkomst: boolean
  jamkningPercentage: number | null
  jamkningValidFrom: string | null
  jamkningValidTo: string | null
  fSkattStatus: string

  /** Age (from personnummer) */
  personnummer: string // encrypted, will be decrypted for age calc
  paymentDate: string

  /** Vacation */
  vacationRule: 'procentregeln' | 'sammaloneregeln' | 'none' | 'semesterersattning'
  vacationDaysPerYear: number
  semestertillaggRate: number

  /** Växa-stöd */
  vaxaStodEligible: boolean
  vaxaStodStart: string | null
  vaxaStodEnd: string | null

  /** Line items */
  lineItems: CalculationLineItem[]

  /**
   * Pay period bounds (YYYY-MM-DD). Together with employmentStart/employmentEnd
   * they drive partial-month proration: an employee hired mid-period or
   * terminated mid-period receives only the workday-fraction of base salary.
   * When omitted, proration is skipped (ratio = 1).
   */
  periodStart?: string
  periodEnd?: string
  employmentStart?: string
  employmentEnd?: string | null
}

export interface CalculationLineItem {
  itemType: SalaryLineItemType
  amount: number
  isTaxable: boolean
  isAvgiftBasis: boolean
  isVacationBasis: boolean
  isGrossDeduction: boolean
  isNetDeduction: boolean
}

export interface CalculationStep {
  label: string
  formula: string
  input: Record<string, number | string>
  /** Numeric result for the step. `null` for context-only rows (e.g. avgiftskategori) that describe a rule, not a calculation. */
  output: number | null
}

export interface SalaryCalculationResult {
  grossSalary: number
  grossDeductions: number
  benefitValues: number
  taxableIncome: number
  taxWithheld: number
  netDeductions: number
  netSalary: number
  avgifterRate: number
  avgifterAmount: number
  avgifterBasis: number
  avgifterCategory: AvgifterCalculation['category']
  vacationAccrual: number
  vacationAccrualAvgifter: number
  /** Semesterersättning paid out directly (vacation_rule = 'semesterersattning'). 0 otherwise. */
  vacationCompensation: number
  totalEmployerCost: number
  steps: CalculationStep[]
}

export interface AvgifterCalculation {
  rate: number
  amount: number
  basis: number
  category: 'standard' | 'reduced_65plus' | 'youth' | 'vaxa_stod' | 'exempt'
  steps: CalculationStep[]
}

// ============================================================
// Rounding / formatting helpers
// ============================================================

function r(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * Sum vacation-basis line items that ADD to base salary (overtime, bonus,
 * etc). Excludes monthly_salary/hourly_salary because those line items mirror
 * the engine's own baseSalary computation: counting them would double the
 * vacation basis.
 */
function vacationBasisAdditions(lineItems: CalculationLineItem[]): number {
  return lineItems
    .filter(li => li.isVacationBasis)
    .filter(li => li.itemType !== 'monthly_salary' && li.itemType !== 'hourly_salary')
    .reduce((sum, li) => sum + li.amount, 0)
}

/**
 * Format a rate (0.2081) as a Swedish percentage string ("20,81 %").
 * Strips trailing zeros, uses Swedish comma as decimal separator, and rounds
 * to avoid JS floating-point noise like "20.810000000000002".
 */
function fmtPct(decimal: number, decimals = 2): string {
  const pct = decimal * 100
  const rounded = Math.round(pct * 10 ** decimals) / 10 ** decimals
  const str = rounded
    .toFixed(decimals)
    .replace(/\.?0+$/, '')
    .replace('.', ',')
  return `${str} %`
}

/**
 * Format an integer amount with Swedish thousand-separators and "kr" suffix,
 * for embedding inside formula descriptions ("25 000 kr").
 */
function fmtKr(amount: number): string {
  return `${Math.round(amount).toLocaleString('sv-SE')} kr`
}

// ============================================================
// Partial-month proration
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000

function parseIsoDateUtc(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b
}

/**
 * Count Mon-Fri days inclusive between start and end (YYYY-MM-DD). Returns 0
 * when start > end. Swedish bank holidays are NOT excluded: the engine uses
 * the same 21-workday convention used elsewhere (monthlySalary / 21), so a
 * variable workday count that excluded holidays would diverge from the
 * baseline daily rate convention.
 */
function countWorkdaysInclusive(start: string, end: string): number {
  if (start > end) return 0
  const startMs = parseIsoDateUtc(start).getTime()
  const endMs = parseIsoDateUtc(end).getTime()
  const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1
  let workdays = 0
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startMs + i * DAY_MS)
    const dow = d.getUTCDay() // 0 = Sun, 6 = Sat
    if (dow >= 1 && dow <= 5) workdays += 1
  }
  return workdays
}

/**
 * Fraction of the pay period the employee was actually employed, measured in
 * Mon-Fri workdays. Returns 1 when the employee was employed for the full
 * period (or when employment dates / period bounds are missing). Returns 0
 * when the employee was not employed at all during the period.
 *
 * This is the standard Swedish payroll convention for partial-month proration:
 * an employee hired 2026-05-15 gets workdays-in-(May 15-31) / workdays-in-May.
 * Hourly employees are not prorated here: they are paid for actually-worked
 * hours, so the calling code passes salaryType='monthly' to gate this.
 */
export function prorateBaseSalaryForPeriod(
  employmentStart: string | undefined,
  employmentEnd: string | null | undefined,
  periodStart: string | undefined,
  periodEnd: string | undefined,
): number {
  if (!periodStart || !periodEnd) return 1
  if (!employmentStart) return 1
  const effectiveStart = maxDate(employmentStart, periodStart)
  const effectiveEnd = employmentEnd ? minDate(employmentEnd, periodEnd) : periodEnd
  if (effectiveStart > effectiveEnd) return 0
  // Fast path: employment fully covers the period.
  if (employmentStart <= periodStart && (!employmentEnd || employmentEnd >= periodEnd)) {
    return 1
  }
  const overlap = countWorkdaysInclusive(effectiveStart, effectiveEnd)
  const total = countWorkdaysInclusive(periodStart, periodEnd)
  if (total === 0) return 1
  const ratio = overlap / total
  if (ratio < 0) return 0
  if (ratio > 1) return 1
  return ratio
}

// ============================================================
// Main calculation
// ============================================================

/**
 * Calculate salary for one employee in a salary run.
 * Follows the legally mandated processing order:
 *   1. Base salary
 *   2. Add additions (overtime, bonus, etc.)
 *   3. Subtract absence deductions
 *   4. Apply bruttolöneavdrag (MUST be before tax)
 *   5. Add förmånsvärden to tax base
 *   6. Tax withholding
 *   7. Net salary
 *   8. Employer contributions (avgifter)
 *   9. Vacation accrual
 *  10. Avgifter on vacation accrual
 */
export function calculateSalary(
  input: SalaryCalculationInput,
  config: PayrollConfig,
  taxRates: TaxTableRate[]
): SalaryCalculationResult {
  const steps: CalculationStep[] = []

  // ─── Step 1: Base salary ───
  let baseSalary: number
  if (input.salaryType === 'monthly') {
    const degreeAdjusted = r(input.monthlySalary * (input.employmentDegree / 100))
    const prorationRatio = prorateBaseSalaryForPeriod(
      input.employmentStart,
      input.employmentEnd,
      input.periodStart,
      input.periodEnd,
    )
    if (prorationRatio < 1 && input.periodStart && input.periodEnd) {
      baseSalary = r(degreeAdjusted * prorationRatio)
      const overlapStart = input.employmentStart && input.employmentStart > input.periodStart
        ? input.employmentStart
        : input.periodStart
      const overlapEnd = input.employmentEnd && input.employmentEnd < input.periodEnd
        ? input.employmentEnd
        : input.periodEnd
      steps.push({
        label: 'Grundlön (proportionerad anställningsperiod)',
        formula: 'månadslön × (sysselsättningsgrad / 100) × (arbetsdagar i anställning / arbetsdagar i period)',
        input: {
          monthly_salary: input.monthlySalary,
          employment_degree: input.employmentDegree,
          degree_adjusted: degreeAdjusted,
          overlap_start: overlapStart,
          overlap_end: overlapEnd,
          proration_ratio: Math.round(prorationRatio * 10000) / 10000,
        },
        output: baseSalary,
      })
    } else {
      baseSalary = degreeAdjusted
      steps.push({
        label: 'Grundlön',
        formula: 'månadslön × (sysselsättningsgrad / 100)',
        input: { monthly_salary: input.monthlySalary, employment_degree: input.employmentDegree },
        output: baseSalary,
      })
    }
  } else {
    const hours = input.hoursWorked || 0
    const rate = input.hourlyRate || 0
    baseSalary = r(rate * hours)
    steps.push({
      label: 'Grundlön (timavlönad)',
      formula: 'timlön × arbetade timmar',
      input: { hourly_rate: rate, hours_worked: hours },
      output: baseSalary,
    })
  }

  // ─── Step 2: Add additions ───
  // OB-tillägg + tiered overtime are treated as additions to gross salary on
  // top of the base salary. They were already computed in cash terms by the
  // shift-premium engine before the calc engine ran, so we just sum them in.
  const ADDITION_TYPES: SalaryLineItemType[] = [
    'overtime', 'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
    'bonus', 'commission',
  ]
  const additions = input.lineItems.filter(
    li => ADDITION_TYPES.includes(li.itemType) && li.amount > 0
  )
  const totalAdditions = r(additions.reduce((sum, li) => sum + li.amount, 0))
  if (totalAdditions > 0) {
    steps.push({
      label: 'Tillägg (övertid, OB, bonus, provision)',
      formula: 'summa tillägg',
      input: { count: additions.length },
      output: totalAdditions,
    })
  }

  // ─── Step 3: Subtract absence deductions ───
  const absenceItems = input.lineItems.filter(
    li => ['sick_karens', 'sick_day2_14', 'sick_day15_plus', 'vab', 'parental_leave', 'unpaid_leave', 'vacation'].includes(li.itemType)
  )
  const totalAbsence = r(absenceItems.reduce((sum, li) => sum + li.amount, 0))
  if (totalAbsence !== 0) {
    steps.push({
      label: 'Frånvaro (sjuk, VAB, semester, föräldraledig)',
      formula: 'summa frånvaroposter',
      input: { count: absenceItems.length },
      output: totalAbsence,
    })
  }

  // ─── Step 4: Bruttolöneavdrag (MUST be before tax) ───
  const grossDeductionItems = input.lineItems.filter(li => li.isGrossDeduction)
  const totalGrossDeductions = r(Math.abs(grossDeductionItems.reduce((sum, li) => sum + li.amount, 0)))
  if (totalGrossDeductions > 0) {
    steps.push({
      label: 'Bruttolöneavdrag',
      formula: 'summa bruttoavdrag',
      input: { count: grossDeductionItems.length },
      output: -totalGrossDeductions,
    })
  }

  // ─── Step 4b: Semesterersättning (paid out directly per cycle) ───
  // When vacation_rule = 'semesterersattning' the employer pays 12% (or 14.4%
  // for 30+ days) on top of each paycheck instead of accruing semesterlöneskuld.
  // It's part of bruttolön and counts for both tax and avgifter basis.
  let vacationCompensation = 0
  if (input.vacationRule === 'semesterersattning') {
    const rate = input.vacationDaysPerYear >= 30 ? 0.144 : 0.12
    const compensationBasis = r(baseSalary + vacationBasisAdditions(input.lineItems))
    vacationCompensation = r(compensationBasis * rate)
    steps.push({
      label: `Semesterersättning (${fmtPct(rate)})`,
      formula: `semesterunderlag × ${fmtPct(rate)} (betalas ut, ingen avsättning)`,
      input: { compensation_basis: compensationBasis, rate },
      output: vacationCompensation,
    })
  }

  // Gross salary = base + additions + absence (may be negative for deductions) + semesterersättning - gross deductions
  const grossSalary = r(baseSalary + totalAdditions + totalAbsence + vacationCompensation - totalGrossDeductions)
  steps.push({
    label: 'Bruttolön',
    formula: vacationCompensation > 0
      ? 'grundlön + tillägg + frånvaro + semesterersättning − bruttoavdrag'
      : 'grundlön + tillägg + frånvaro − bruttoavdrag',
    input: { base: baseSalary, additions: totalAdditions, absence: totalAbsence, vacation_compensation: vacationCompensation, gross_deductions: totalGrossDeductions },
    output: grossSalary,
  })

  // ─── Step 5: Add förmånsvärden to tax base ───
  const benefitItems = input.lineItems.filter(
    li => ['benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other'].includes(li.itemType)
  )
  const totalBenefits = r(benefitItems.reduce((sum, li) => sum + li.amount, 0))
  if (totalBenefits > 0) {
    steps.push({
      label: 'Förmånsvärden',
      formula: 'summa förmåner',
      input: { count: benefitItems.length },
      output: totalBenefits,
    })
  }

  const taxableIncome = r(grossSalary + totalBenefits)
  steps.push({
    label: 'Skattegrundande inkomst',
    formula: 'bruttolön + förmåner',
    input: { gross_salary: grossSalary, benefit_values: totalBenefits },
    output: taxableIncome,
  })

  // ─── Step 6: Tax withholding ───
  let taxWithheld: number
  const paymentYear = parseInt(input.paymentDate.split('-')[0])

  if (input.fSkattStatus === 'f_skatt') {
    // F-skatt holder: no withholding
    taxWithheld = 0
    steps.push({
      label: 'Skatteavdrag (F-skatt)',
      formula: 'F-skattsedel: inget skatteavdrag görs',
      input: {},
      output: 0,
    })
  } else if (input.fSkattStatus === 'not_verified') {
    // Unverified: flat 30%
    taxWithheld = r(taxableIncome * 0.30)
    steps.push({
      label: 'Skatteavdrag (ej verifierad)',
      formula: 'skattegrundande inkomst × 30 %',
      input: { taxable_income: taxableIncome },
      output: taxWithheld,
    })
  } else if (input.isSidoinkomst) {
    // Sidoinkomst: flat 30%
    taxWithheld = calculateSidoinkomstTax(taxableIncome)
    steps.push({
      label: 'Skatteavdrag (sidoinkomst 30 %)',
      formula: 'skattegrundande inkomst × 30 %',
      input: { taxable_income: taxableIncome },
      output: taxWithheld,
    })
  } else if (input.jamkningPercentage !== null && isJamkningValid(input.jamkningValidFrom, input.jamkningValidTo, input.paymentDate)) {
    // Jämkning
    taxWithheld = calculateJamkningTax(taxableIncome, input.jamkningPercentage)
    steps.push({
      label: `Skatteavdrag (jämkning ${input.jamkningPercentage} %)`,
      formula: `skattegrundande inkomst × ${input.jamkningPercentage} %`,
      input: { taxable_income: taxableIncome, jamkning_percentage: input.jamkningPercentage },
      output: taxWithheld,
    })
  } else if (input.taxTableNumber) {
    // Normal tax table lookup
    taxWithheld = lookupTaxAmount(input.taxTableNumber, input.taxColumn, taxableIncome, taxRates)
    steps.push({
      label: `Skatteavdrag (tabell ${input.taxTableNumber}, kolumn ${input.taxColumn})`,
      formula: `skattetabell ${input.taxTableNumber}, kolumn ${input.taxColumn}, inkomst ${fmtKr(taxableIncome)}`,
      input: { table: input.taxTableNumber, column: input.taxColumn, taxable_income: taxableIncome },
      output: taxWithheld,
    })
  } else {
    // Fallback: flat 30%
    taxWithheld = r(taxableIncome * 0.30)
    steps.push({
      label: 'Skatteavdrag (30 % schablon)',
      formula: 'skattegrundande inkomst × 30 %',
      input: { taxable_income: taxableIncome },
      output: taxWithheld,
    })
  }

  // ─── Step 7: Net salary ───
  const netDeductionItems = input.lineItems.filter(li => li.isNetDeduction)
  const totalNetDeductions = r(Math.abs(netDeductionItems.reduce((sum, li) => sum + li.amount, 0)))

  const netSalary = r(grossSalary - taxWithheld - totalNetDeductions)
  steps.push({
    label: 'Nettolön',
    formula: 'bruttolön − skatt − nettoavdrag',
    input: { gross: grossSalary, tax: taxWithheld, net_deductions: totalNetDeductions },
    output: netSalary,
  })

  // ─── Step 8: Employer contributions (avgifter) ───
  const avgifterCalc = calculateAvgifterRate(input, config, paymentYear)
  const avgifterBasis = r(grossSalary + totalBenefits)

  // Handle salary caps for youth and växa-stöd:
  // Reduced rate applies only up to the cap, standard rate on the rest
  let avgifterAmount: number
  if (avgifterCalc.category === 'youth' && config.avgifterYouthSalaryCap && avgifterBasis > config.avgifterYouthSalaryCap) {
    const reducedPart = r(config.avgifterYouthSalaryCap * avgifterCalc.rate)
    const standardPart = r((avgifterBasis - config.avgifterYouthSalaryCap) * config.avgifterTotal)
    avgifterAmount = r(reducedPart + standardPart)
    steps.push(...avgifterCalc.steps)
    steps.push({
      label: 'Arbetsgivaravgifter (ungdomsrabatt med tak)',
      formula: `${fmtKr(config.avgifterYouthSalaryCap)} × ${fmtPct(avgifterCalc.rate)} + ${fmtKr(avgifterBasis - config.avgifterYouthSalaryCap)} × ${fmtPct(config.avgifterTotal)}`,
      input: { cap: config.avgifterYouthSalaryCap, reduced: reducedPart, standard: standardPart },
      output: avgifterAmount,
    })
  } else if (avgifterCalc.category === 'vaxa_stod' && config.avgifterVaxaStodCap && avgifterBasis > config.avgifterVaxaStodCap) {
    const reducedPart = r(config.avgifterVaxaStodCap * avgifterCalc.rate)
    const standardPart = r((avgifterBasis - config.avgifterVaxaStodCap) * config.avgifterTotal)
    avgifterAmount = r(reducedPart + standardPart)
    steps.push(...avgifterCalc.steps)
    steps.push({
      label: 'Arbetsgivaravgifter (växa-stöd med tak)',
      formula: `${fmtKr(config.avgifterVaxaStodCap)} × ${fmtPct(avgifterCalc.rate)} + ${fmtKr(avgifterBasis - config.avgifterVaxaStodCap)} × ${fmtPct(config.avgifterTotal)}`,
      input: { cap: config.avgifterVaxaStodCap, reduced: reducedPart, standard: standardPart },
      output: avgifterAmount,
    })
  } else {
    avgifterAmount = r(avgifterBasis * avgifterCalc.rate)
    steps.push(...avgifterCalc.steps)
    steps.push({
      label: 'Arbetsgivaravgifter',
      formula: `avgiftsunderlag × ${fmtPct(avgifterCalc.rate)}`,
      input: { avgifter_basis: avgifterBasis, rate: avgifterCalc.rate },
      output: avgifterAmount,
    })
  }

  // ─── Step 9: Vacation accrual ───
  // Vacation basis = baseSalary (computed at the top) + any *additional*
  // vacation-basis line items (overtime, bonus, etc). We must NOT add
  // monthly_salary/hourly_salary line items here: those are auto-created at
  // employee-add time and represent the same baseSalary already accounted for.
  const vacationBasis = r(baseSalary + vacationBasisAdditions(input.lineItems))
  let vacationAccrual: number
  if (input.vacationRule === 'none') {
    vacationAccrual = 0
    steps.push({
      label: 'Semesteravsättning (avstängd)',
      formula: 'ingen semesteravsättning bokas: semester ingår i månadslönen',
      input: {},
      output: 0,
    })
  } else if (input.vacationRule === 'semesterersattning') {
    vacationAccrual = 0
    steps.push({
      label: 'Semesteravsättning (semesterersättning betald direkt)',
      formula: 'ingen avsättning: 12 % betalas ut på varje lön',
      input: {},
      output: 0,
    })
  } else if (input.vacationRule === 'procentregeln') {
    const rate = input.vacationDaysPerYear >= 30 ? 0.144 : 0.12
    vacationAccrual = r(vacationBasis * rate)
    steps.push({
      label: `Semesteravsättning (procentregeln ${fmtPct(rate)})`,
      formula: `semesterunderlag × ${fmtPct(rate)}`,
      input: { vacation_basis: vacationBasis, rate },
      output: vacationAccrual,
    })
  } else {
    // Sammalöneregeln (§16a): employee keeps regular salary during vacation
    // + semestertillägg per day (min 0.43%, often 0.8% per CBA)
    // Accrual = tillägg only (salary cost is already in normal monthly expense)
    // The liability (2920) for sammalöneregeln is the tillägg portion,
    // since the base salary is expensed monthly regardless of vacation.
    // Use baseSalary (degree-adjusted): a 50% part-timer's tillägg should be
    // half a full-timer's, not the same.
    const dailyRate = r(baseSalary / 21)
    const tillagg = r(dailyRate * input.semestertillaggRate * input.vacationDaysPerYear)
    vacationAccrual = tillagg
    steps.push({
      label: `Semesteravsättning (sammalöneregeln, tillägg ${fmtPct(input.semestertillaggRate)})`,
      formula: `dagslön × ${fmtPct(input.semestertillaggRate)} × semesterdagar`,
      input: { daily_rate: dailyRate, semestertillagg_rate: input.semestertillaggRate, vacation_days: input.vacationDaysPerYear },
      output: vacationAccrual,
    })
  }

  // ─── Step 10: Avgifter on vacation accrual ───
  const vacationAccrualAvgifter = r(vacationAccrual * avgifterCalc.rate)
  steps.push({
    label: 'Arbetsgivaravgifter på semesteravsättning',
    formula: `semesteravsättning × ${fmtPct(avgifterCalc.rate)}`,
    input: { vacation_accrual: vacationAccrual, avgifter_rate: avgifterCalc.rate },
    output: vacationAccrualAvgifter,
  })

  const totalEmployerCost = r(grossSalary + avgifterAmount + vacationAccrual + vacationAccrualAvgifter)
  steps.push({
    label: 'Total arbetsgivarkostnad',
    formula: 'bruttolön + avgifter + semesteravsättning + avgifter på semester',
    input: { gross: grossSalary, avgifter: avgifterAmount, vacation_accrual: vacationAccrual, vacation_avgifter: vacationAccrualAvgifter },
    output: totalEmployerCost,
  })

  return {
    grossSalary,
    grossDeductions: totalGrossDeductions,
    benefitValues: totalBenefits,
    taxableIncome,
    taxWithheld,
    netDeductions: totalNetDeductions,
    netSalary,
    avgifterRate: avgifterCalc.rate,
    avgifterAmount,
    avgifterBasis,
    avgifterCategory: avgifterCalc.category,
    vacationAccrual,
    vacationAccrualAvgifter,
    vacationCompensation,
    totalEmployerCost,
    steps,
  }
}

// ============================================================
// Avgifter calculation
// ============================================================

/**
 * Determine arbetsgivaravgifter rate based on employee age, växa-stöd, etc.
 */
export function calculateAvgifterRate(
  input: SalaryCalculationInput,
  config: PayrollConfig,
  paymentYear: number
): AvgifterCalculation {
  const steps: CalculationStep[] = []

  // Decrypt personnummer to calculate age
  let pnr: string
  try {
    pnr = decryptPersonnummer(input.personnummer)
  } catch {
    // If decryption fails, assume standard rate
    return {
      rate: config.avgifterTotal,
      amount: 0,
      basis: 0,
      category: 'standard',
      steps: [{
        label: 'Avgiftskategori',
        formula: `Standard ${fmtPct(config.avgifterTotal)} (personnummer kunde inte dekrypteras)`,
        input: {},
        output: null,
      }],
    }
  }

  const ageAtYearStart = calculateAgeAtYearStart(pnr, paymentYear)

  // Born ≤1937: 0%
  const birthYear = parseInt(pnr.slice(0, 4))
  if (birthYear <= 1937) {
    steps.push({
      label: 'Avgiftskategori',
      formula: 'Född 1937 eller tidigare: inga arbetsgivaravgifter',
      input: { birth_year: birthYear },
      output: null,
    })
    return { rate: 0, amount: 0, basis: 0, category: 'exempt', steps }
  }

  // 67+ at year start (reduced: only ålderspension)
  if (ageAtYearStart >= config.reducedAvgiftAge) {
    steps.push({
      label: 'Avgiftskategori',
      formula: `Ålder ${ageAtYearStart} år: reducerad avgift ${fmtPct(config.avgifterReduced65plus)} (endast ålderspensionsavgift)`,
      input: { age: ageAtYearStart, threshold: config.reducedAvgiftAge },
      output: null,
    })
    return { rate: config.avgifterReduced65plus, amount: 0, basis: 0, category: 'reduced_65plus', steps }
  }

  // Växa-stöd eligible
  if (input.vaxaStodEligible && input.vaxaStodStart && input.vaxaStodEnd) {
    const payDate = input.paymentDate
    if (payDate >= input.vaxaStodStart && payDate <= input.vaxaStodEnd && config.avgifterVaxaStodRate !== null) {
      steps.push({
        label: 'Avgiftskategori',
        formula: `Växa-stöd ${fmtPct(config.avgifterVaxaStodRate ?? 0)} på första ${fmtKr(config.avgifterVaxaStodCap ?? 0)}`,
        input: { vaxa_cap: config.avgifterVaxaStodCap ?? 0 },
        output: null,
      })
      return { rate: config.avgifterVaxaStodRate ?? config.avgifterTotal, amount: 0, basis: 0, category: 'vaxa_stod', steps }
    }
  }

  // Youth rate (ungdomsrabatt 2026-2027, Prop. 2025/26:66):
  //   "personer som vid årets ingång har fyllt 18 men inte 23 år"
  // → eligible at årets ingång: age >= 18 AND age < 23 (i.e. age ≤ 22 on Jan 1).
  // The Riksdag betänkande's "19-23-åringar" wording is colloquial: those
  // eligible at year start (18-22) become 19-23 during the year. We test the
  // year-start age, not the during-year age. Skatteverket's AGI validator
  // rejects 23-year-olds at year start as not eligible.
  // Active period: 1 April 2026 - 30 September 2027.
  if (config.avgifterYouthRate !== null && ageAtYearStart >= 18 && ageAtYearStart <= 22) {
    const [, monthStr] = input.paymentDate.split('-')
    const month = parseInt(monthStr)
    const isYouthPeriod = (paymentYear === 2026 && month >= 4) || (paymentYear === 2027 && month <= 9)
    if (isYouthPeriod) {
      steps.push({
        label: 'Avgiftskategori',
        formula: `Ungdomsrabatt (vid årets ingång ${ageAtYearStart} år): ${fmtPct(config.avgifterYouthRate)} på första ${fmtKr(config.avgifterYouthSalaryCap ?? 0)}/mån`,
        input: { age_at_year_start: ageAtYearStart, cap: config.avgifterYouthSalaryCap ?? 0 },
        output: null,
      })
      return { rate: config.avgifterYouthRate, amount: 0, basis: 0, category: 'youth', steps }
    }
  }

  // Standard rate
  steps.push({
    label: 'Avgiftskategori',
    formula: `Standard ${fmtPct(config.avgifterTotal)}`,
    input: { age: ageAtYearStart },
    output: null,
  })
  return { rate: config.avgifterTotal, amount: 0, basis: 0, category: 'standard', steps }
}

// ============================================================
// Sjuklön helpers
// ============================================================

/**
 * Calculate karensavdrag (sick leave deduction day 1).
 * Formula: 20% × (monthly_salary × 12 / 52 × sjuklön_rate)
 */
export function calculateKarensavdrag(monthlySalary: number, config: PayrollConfig): number {
  const weeklySjuklon = r(monthlySalary * 12 / 52 * config.sjuklonRate)
  return r(weeklySjuklon * config.karensavdragFactor)
}

/**
 * Calculate sjuklön for days 2-14.
 * Formula: 80% × daily_rate × (sick_days - 1)
 */
export function calculateSjuklon(
  monthlySalary: number,
  sickDays: number,
  config: PayrollConfig
): { karensavdrag: number; sjuklon: number; totalDeduction: number; steps: CalculationStep[] } {
  const steps: CalculationStep[] = []
  const dailyRate = r(monthlySalary / 21)

  // Karensavdrag
  const karensavdrag = calculateKarensavdrag(monthlySalary, config)
  steps.push({
    label: 'Karensavdrag',
    formula: `20 % × (månadslön × 12/52 × ${fmtPct(config.sjuklonRate)})`,
    input: { monthly_salary: monthlySalary },
    output: karensavdrag,
  })

  // Sjuklön day 2-14
  const sjuklonDays = Math.min(Math.max(sickDays - 1, 0), 13)
  const sjuklon = r(dailyRate * config.sjuklonRate * sjuklonDays)
  steps.push({
    label: 'Sjuklön dag 2-14',
    formula: `dagslön × ${fmtPct(config.sjuklonRate)} × (sjukdagar − 1)`,
    input: { daily_rate: dailyRate, sjuklon_rate: config.sjuklonRate, days: sjuklonDays },
    output: sjuklon,
  })

  // Total deduction from pay = salary they would have earned - sjuklön they get
  const fullPayForPeriod = r(dailyRate * sickDays)
  const totalDeduction = r(-(fullPayForPeriod - sjuklon + karensavdrag))
  steps.push({
    label: 'Netto sjukavdrag',
    formula: '−(full lön − sjuklön + karensavdrag)',
    input: { full_pay: fullPayForPeriod, sjuklon, karensavdrag },
    output: totalDeduction,
  })

  return { karensavdrag, sjuklon, totalDeduction, steps }
}

/**
 * Calculate vacation accrual.
 */
export function calculateVacationAccrual(params: {
  monthlySalary: number
  vacationRule: 'procentregeln' | 'sammaloneregeln' | 'none' | 'semesterersattning'
  vacationDaysPerYear: number
  semestertillaggRate: number
  vacationBasis: number
}): { accrual: number; steps: CalculationStep[] } {
  const steps: CalculationStep[] = []

  if (params.vacationRule === 'none') {
    steps.push({
      label: 'Semesteravsättning (avstängd)',
      formula: 'ingen semesteravsättning',
      input: {},
      output: 0,
    })
    return { accrual: 0, steps }
  }

  if (params.vacationRule === 'semesterersattning') {
    steps.push({
      label: 'Semesteravsättning (semesterersättning betald direkt)',
      formula: 'ingen avsättning: 12 % betalas ut på varje lön',
      input: {},
      output: 0,
    })
    return { accrual: 0, steps }
  }

  if (params.vacationRule === 'procentregeln') {
    const rate = params.vacationDaysPerYear >= 30 ? 0.144 : 0.12
    const accrual = r(params.vacationBasis * rate)
    steps.push({
      label: `Semesteravsättning (procentregeln ${fmtPct(rate)})`,
      formula: `semesterunderlag × ${fmtPct(rate)}`,
      input: { vacation_basis: params.vacationBasis, rate },
      output: accrual,
    })
    return { accrual, steps }
  } else {
    // Sammalöneregeln: tillägg per vacation day. Use vacationBasis as the
    // degree-adjusted reference: callers must pass the part-time-adjusted
    // monthly amount, never the raw full-time monthlySalary.
    const dailyRate = r(params.vacationBasis / 21)
    const accrual = r(dailyRate * params.semestertillaggRate * params.vacationDaysPerYear)
    steps.push({
      label: `Semesteravsättning (sammalöneregeln ${fmtPct(params.semestertillaggRate)})`,
      formula: `dagslön × ${fmtPct(params.semestertillaggRate)} × semesterdagar`,
      input: { daily_rate: dailyRate, rate: params.semestertillaggRate, days: params.vacationDaysPerYear },
      output: accrual,
    })
    return { accrual, steps }
  }
}

// ============================================================
// Helpers
// ============================================================

function isJamkningValid(
  validFrom: string | null,
  validTo: string | null,
  paymentDate: string
): boolean {
  if (!validFrom || !validTo) return false
  return paymentDate >= validFrom && paymentDate <= validTo
}
