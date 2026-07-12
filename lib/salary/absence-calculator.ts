import type { PayrollConfig } from './payroll-config'

/**
 * Absence calculation for Swedish payroll.
 * Implements Sjuklönelagen (SjLL), Semesterlagen, and Föräldraledighetslagen.
 */

export interface SjuklonResult {
  karensavdrag: number
  sjuklonDays: number
  sjuklonAmount: number
  dailyRate: number
  weeklyRate: number
  totalDeduction: number // Net reduction from normal pay
  steps: AbsenceStep[]
}

export interface AbsenceStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

/**
 * Calculate sjuklön for a sick period.
 *
 * Day 1: Karensavdrag = 20% × (monthly × 12/52 × 80%)
 * Day 2-14: 80% of daily rate
 * Day 15+: Försäkringskassan pays (not employer's cost)
 *
 * Återinsjuknande: If employee returns and falls sick again within 5 calendar
 * days, it counts as the same sjuklöneperiod (no new karensavdrag).
 */
export function calculateSjuklon(
  monthlySalary: number,
  sickDays: number,
  config: PayrollConfig,
  isAterinsjuknande: boolean = false
): SjuklonResult {
  const steps: AbsenceStep[] = []
  const r = (x: number) => Math.round(x * 100) / 100

  // Daily rate = monthly / 21 working days
  const dailyRate = r(monthlySalary / 21)
  steps.push({
    label: 'Dagslön',
    formula: 'monthly_salary / 21',
    input: { monthly_salary: monthlySalary },
    output: dailyRate,
  })

  // Weekly sjuklön = monthly × 12 / 52 × 80%
  const weeklyRate = r(monthlySalary * 12 / 52 * config.sjuklonRate)
  steps.push({
    label: 'Veckosjuklön',
    formula: 'monthly × 12/52 × 80%',
    input: { monthly_salary: monthlySalary, sjuklon_rate: config.sjuklonRate },
    output: weeklyRate,
  })

  // Karensavdrag (only if not återinsjuknande within 5 days)
  let karensavdrag = 0
  if (!isAterinsjuknande) {
    karensavdrag = r(weeklyRate * config.karensavdragFactor)
    steps.push({
      label: 'Karensavdrag',
      formula: 'veckosjuklön × 20%',
      input: { weekly_sjuklon: weeklyRate, factor: config.karensavdragFactor },
      output: karensavdrag,
    })
  } else {
    steps.push({
      label: 'Karensavdrag (återinsjuknande)',
      formula: '0 (inom 5 kalenderdagar)',
      input: {},
      output: 0,
    })
  }

  // Sjuklön day 2-14: 80% of daily rate
  const sjuklonDays = Math.min(Math.max(sickDays - (isAterinsjuknande ? 0 : 1), 0), 13)
  const sjuklonAmount = r(dailyRate * config.sjuklonRate * sjuklonDays)
  steps.push({
    label: 'Sjuklön dag 2-14',
    formula: 'dagslön × 80% × sjukdagar',
    input: { daily_rate: dailyRate, sjuklon_rate: config.sjuklonRate, days: sjuklonDays },
    output: sjuklonAmount,
  })

  // Total deduction = what employee loses vs normal pay
  // Normal pay for period = dailyRate × sickDays
  // They get: sjuklön - karensavdrag (karensavdrag reduces their sjuklön)
  const normalPay = r(dailyRate * sickDays)
  const totalDeduction = r(normalPay - sjuklonAmount + karensavdrag)
  steps.push({
    label: 'Löneavdrag sjukfrånvaro',
    formula: 'normal_pay - sjuklön + karensavdrag',
    input: { normal_pay: normalPay, sjuklon: sjuklonAmount, karensavdrag },
    output: totalDeduction,
  })

  return {
    karensavdrag,
    sjuklonDays,
    sjuklonAmount,
    dailyRate,
    weeklyRate,
    totalDeduction,
    steps,
  }
}

/**
 * Calculate VAB (vård av barn) deduction.
 * Full daily rate deduction: Försäkringskassan compensates the parent.
 * Semesterlönegrundande for first 120 days (180 for sole custody) per §17b.
 */
export function calculateVabDeduction(
  monthlySalary: number,
  vabDays: number,
  totalVabDaysThisYear: number = 0
): { deduction: number; semesterGrundande: boolean; steps: AbsenceStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const dailyRate = r(monthlySalary / 21)
  const deduction = r(dailyRate * vabDays)
  const semesterGrundande = totalVabDaysThisYear + vabDays <= 120

  return {
    deduction,
    semesterGrundande,
    steps: [{
      label: 'VAB-avdrag',
      formula: 'dagslön × vab_dagar',
      input: { daily_rate: dailyRate, vab_days: vabDays, ytd_days: totalVabDaysThisYear },
      output: deduction,
    }],
  }
}

/**
 * Calculate parental leave deduction.
 * Semesterlönegrundande for first 120 days per pregnancy per §17a.
 */
export function calculateParentalLeaveDeduction(
  monthlySalary: number,
  parentalDays: number,
  totalParentalDaysThisPregnancy: number = 0
): { deduction: number; semesterGrundande: boolean; steps: AbsenceStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const dailyRate = r(monthlySalary / 21)
  const deduction = r(dailyRate * parentalDays)
  const semesterGrundande = totalParentalDaysThisPregnancy + parentalDays <= 120

  return {
    deduction,
    semesterGrundande,
    steps: [{
      label: 'Föräldraledigavdrag',
      formula: 'dagslön × föräldradagar',
      input: { daily_rate: dailyRate, parental_days: parentalDays },
      output: deduction,
    }],
  }
}

/**
 * Calculate vacation pay for taken vacation days.
 *
 * Sammalöneregeln (§16a): Regular pay continues + semestertillägg per day
 * Procentregeln (§16): 12% of semesterlönegrundande (14.4% for 30 days)
 */
export function calculateVacationPay(params: {
  monthlySalary: number
  vacationDaysTaken: number
  vacationRule: 'procentregeln' | 'sammaloneregeln' | 'none'
  semestertillaggRate: number
  vacationDaysPerYear: number
}): { amount: number; tillagg: number; steps: AbsenceStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const dailyRate = r(params.monthlySalary / 21)

  if (params.vacationRule === 'none') {
    // No accrual: vacation is included in monthly pay. No tillägg paid.
    return {
      amount: 0,
      tillagg: 0,
      steps: [{
        label: 'Semesterlön (avstängd)',
        formula: 'ingen separat semesterlön: ingår i månadslönen',
        input: { days: params.vacationDaysTaken },
        output: 0,
      }],
    }
  }

  if (params.vacationRule === 'sammaloneregeln') {
    // Sammalöneregeln: regular pay + semestertillägg per day
    const tillagg = r(params.monthlySalary * params.semestertillaggRate * params.vacationDaysTaken)
    return {
      amount: tillagg, // Regular pay continues, only tillägg is extra
      tillagg,
      steps: [{
        label: 'Semestertillägg (sammalöneregeln)',
        formula: 'monthly × tillagg_rate × vacation_days',
        input: {
          monthly_salary: params.monthlySalary,
          rate: params.semestertillaggRate,
          days: params.vacationDaysTaken,
        },
        output: tillagg,
      }],
    }
  } else {
    // Procentregeln: daily vacation pay based on 12% of annual basis
    // This is typically used for hourly workers; the daily rate comes from their accrued pool
    const rate = params.vacationDaysPerYear >= 30 ? 0.144 : 0.12
    const annualBasis = r(params.monthlySalary * 12)
    const totalVacationPay = r(annualBasis * rate)
    const perDay = r(totalVacationPay / params.vacationDaysPerYear)
    const amount = r(perDay * params.vacationDaysTaken)

    return {
      amount,
      tillagg: 0,
      steps: [{
        label: `Semesterlön (procentregeln ${rate * 100}%)`,
        formula: '(annual_basis × rate / entitled_days) × taken_days',
        input: {
          annual_basis: annualBasis,
          rate,
          entitled_days: params.vacationDaysPerYear,
          taken_days: params.vacationDaysTaken,
        },
        output: amount,
      }],
    }
  }
}
