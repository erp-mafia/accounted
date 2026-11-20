/**
 * Engine wiring for the runnable payslip scenarios.
 *
 * Calls the public pure functions in the order run-calculation.ts calls them
 * (step 8a absence derivation, 8e0 vacation-day pricing, 8f calculateSalary)
 * with the same argument shapes: the degree-adjusted salary for deductions,
 * the schedule's day divisor and hours, the company policy. Only the database
 * is skipped. Nothing here computes an expected figure.
 */
import type { SalaryLineItemType } from '@/types'
import { roundOre } from '@/lib/money'
import { calculateSalary, type CalculationLineItem, type SalaryCalculationResult } from '../../calculation-engine'
import { SalaryCalculationPolicySchema, type SalaryCalculationPolicy } from '../../calculation-policy'
import { deriveAbsenceLineItems, type AbsenceDay, type DeriveResult, type DerivedLineItem } from '../../derive-absence-line-items'
import type { PayrollConfig } from '../../payroll-config'
import { FALLBACK_TAX_TABLES_2026 } from '../../tax-tables-fallback'
import type { TaxTableRate } from '../../tax-tables'
import {
  deriveVacationDaysPay,
  procentregelnDayValue,
  type DerivedVacationPayRow,
  type ProcentregelnBasisPayslip,
  type VacationDaysOff,
  type VacationPayRowKind,
} from '../../vacation-days-pay'
import { paidDaysPerDayOff } from '../../vacation-net-days'
import type { VacationYearBasis } from '../../vacation-year'
import { dailyDivisor, degreeAdjustedMonthlySalary, scheduledHoursPerDay } from '../../work-schedule'

/** The 2026 payroll config, rates per the swedish-payroll skill (social-charges.md, benefits.md, sick-pay.md). */
export const CONFIG_2026: PayrollConfig = {
  configYear: 2026,
  avgifterTotal: 0.3142,
  avgifterAlderspension: 0.1021,
  avgifterSjukforsakring: 0.0355,
  avgifterForaldraforsakring: 0.02,
  avgifterEfterlevandepension: 0.003,
  avgifterArbetsmarknad: 0.0264,
  avgifterArbetsskada: 0.001,
  avgifterAllmanLoneavgift: 0.1262,
  avgifterReduced65plus: 0.1021,
  avgifterYouthRate: 0.2081,
  avgifterYouthSalaryCap: 25000,
  avgifterVaxaStodRate: 0.1021,
  avgifterVaxaStodCap: 35000,
  avgifterMinimumAnnual: 1000,
  egenavgifterTotal: 0.2897,
  slpRate: 0.2426,
  prisbasbelopp: 59200,
  inkomstbasbelopp: 83400,
  maxPgi: 625500,
  sgiCeiling: 592000,
  statligSkattBrytpunkt: 660400,
  traktamenteHeldag: 300,
  traktamenteHalvdag: 150,
  traktamenteNatt: 150,
  milersattningEgenBil: 25,
  milersattningFormansbilFossil: 12,
  milersattningFormansbilEl: 9.5,
  kostformanHeldag: 310,
  kostformanLunch: 124,
  kostformanFrukost: 62,
  friskvardCap: 5000,
  bilformanSlr: 0.0255,
  sjuklonRate: 0.8,
  karensavdragFactor: 0.2,
  maxKarensavdragPerYear: 10,
  reducedAvgiftAge: 67,
}

/** Skatteverket's 2026 monthly tables as the engine reads them (tax-tables.ts getFallbackRates). */
export function taxRates2026(table: number, column: number): TaxTableRate[] {
  const rows = FALLBACK_TAX_TABLES_2026[table] ?? []
  return rows.map((row) => {
    const base = { tableYear: 2026, tableNumber: table, columnNumber: column, incomeFrom: row[0], incomeTo: row[1] || 9999999 }
    return row[8] === 1
      ? { ...base, kind: 'percent' as const, taxPercent: row[column + 1] }
      : { ...base, kind: 'amount' as const, taxAmount: row[column + 1] }
  })
}

// ---------------------------------------------------------------------------
// Scenario input and expectation shapes
// ---------------------------------------------------------------------------

export interface EmployeeSpec {
  salaryType: 'monthly' | 'hourly'
  /** employees.monthly_salary: the FULL-TIME salary. */
  monthlySalary: number
  employmentDegree?: number
  hourlyRate?: number
  hoursWorked?: number
  /** Scheduled hours per week, already at the employment degree. Default 40. */
  hoursPerWeek?: number
  workdaysPerWeek?: number
  /** 12 digits, plaintext (decryptPersonnummer is identity in the scenario tests). */
  personnummer: string
  taxTable: number | null
  taxColumn?: number
  vacationRule: 'procentregeln' | 'sammaloneregeln' | 'none' | 'semesterersattning'
  vacationDaysPerYear?: number
  semestertillaggRate?: number
  vacationPayRate?: number | null
  employmentStart: string
  employmentEnd?: string | null
}

export interface PayslipInputs {
  employee: EmployeeSpec
  period: { start: string; end: string; paymentDate: string }
  policy?: Partial<SalaryCalculationPolicy>
  absence?: {
    periodDays: AbsenceDay[]
    lookbackSickDays?: AbsenceDay[]
    vabDaysYtd?: number
    parentalDaysYtd?: number
  }
  /** Days-only vacation lines on the payslip, and the earning year's payslips for procentregeln. */
  vacation?: {
    days: Partial<VacationDaysOff>
    basis?: VacationYearBasis
    basisPayslips?: ProcentregelnBasisPayslip[]
  }
  /** Manual lines (bonus, benefit, semesterersättning, nettolöneavdrag), engine shape. */
  lines?: CalculationLineItem[]
  roundNetToWholeKrona?: boolean
}

export type AbsenceRowType = DerivedLineItem['item_type']

export interface PayslipExpected {
  grossSalary?: number
  taxableIncome?: number
  benefitValues?: number
  taxWithheld?: number
  netSalary?: number
  avgifterRate?: number
  avgifterAmount?: number
  vacationAccrual?: number
  vacationAccrualAvgifter?: number
  /** Sum of the derived absence rows per type; a type left out must not appear. */
  absenceRows?: Partial<Record<AbsenceRowType, number>>
  /** Sum of the derived vacation-pay rows per kind; a kind left out must not appear. */
  vacationRows?: Partial<Record<VacationPayRowKind, number>>
  fkReporting?: boolean
  lakarintyg?: boolean
}

export interface PayslipRun {
  result: SalaryCalculationResult
  absence: DeriveResult
  vacationRows: DerivedVacationPayRow[]
}

export function sickDay(date: string, hours = 8): AbsenceDay {
  return { absence_date: date, absence_type: 'sick', hours }
}

export function absenceDays(type: AbsenceDay['absence_type'], dates: string[], hours = 8): AbsenceDay[] {
  return dates.map((absence_date) => ({ absence_date, absence_type: type, hours }))
}

/** A wage addition as the manual line dialog stores it (manual-payslip-lines.ts WAGE flags). */
export function wageLine(itemType: SalaryLineItemType, amount: number, oneOffTaxPercent?: number): CalculationLineItem {
  return {
    itemType,
    amount,
    isTaxable: true,
    isAvgiftBasis: true,
    isVacationBasis: true,
    isGrossDeduction: false,
    isNetDeduction: false,
    oneOffTaxPercent: oneOffTaxPercent ?? null,
  }
}

export function benefitLine(itemType: SalaryLineItemType, amount: number): CalculationLineItem {
  return { itemType, amount, isTaxable: true, isAvgiftBasis: true, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: false }
}

export function netDeductionLine(itemType: SalaryLineItemType, amount: number): CalculationLineItem {
  return { itemType, amount, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: true }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runPayslip(inputs: PayslipInputs): PayslipRun {
  const emp = inputs.employee
  const hourly = emp.salaryType === 'hourly'
  const degree = emp.employmentDegree ?? 100
  const hoursPerWeek = emp.hoursPerWeek ?? 40
  const workdaysPerWeek = emp.workdaysPerWeek ?? 5
  const vacationDaysPerYear = emp.vacationDaysPerYear ?? 25
  const semestertillaggRate = emp.semestertillaggRate ?? 0.0043
  const policy = SalaryCalculationPolicySchema.parse(inputs.policy ?? {})
  const monthlyAtDegree = hourly ? 0 : degreeAdjustedMonthlySalary(emp.monthlySalary, degree)

  // 8a. Absence.
  const lookback = inputs.absence?.lookbackSickDays ?? []
  const absence = deriveAbsenceLineItems({
    monthlySalary: monthlyAtDegree,
    salaryType: emp.salaryType,
    hourlyRate: hourly ? emp.hourlyRate : null,
    payrollConfig: CONFIG_2026,
    periodDays: inputs.absence?.periodDays ?? [],
    lookbackSickDates: lookback.map((d) => d.absence_date),
    lookbackSickDays: lookback,
    vabDaysYtd: inputs.absence?.vabDaysYtd ?? 0,
    parentalDaysPregnancyYtd: inputs.absence?.parentalDaysYtd ?? 0,
    dailyDivisor: dailyDivisor(workdaysPerWeek),
    hoursPerDay: scheduledHoursPerDay(hoursPerWeek, workdaysPerWeek),
    hoursPerWeek,
    workdaysPerWeek,
    calculationPolicy: policy,
    periodStart: inputs.period.start,
    periodEnd: inputs.period.end,
    contextDays: [],
  })
  const lineItems: CalculationLineItem[] = [
    ...(inputs.lines ?? []),
    ...absence.lineItems.map((li) => ({
      itemType: li.item_type as SalaryLineItemType,
      amount: li.amount,
      isTaxable: li.is_taxable,
      isAvgiftBasis: li.is_avgift_basis,
      isVacationBasis: li.is_vacation_basis,
      isGrossDeduction: li.is_gross_deduction,
      isNetDeduction: false,
    })),
  ]

  // 8e0. Vacation days.
  let vacationRows: DerivedVacationPayRow[] = []
  if (inputs.vacation) {
    const days: VacationDaysOff = { paid: 0, extraPaid: 0, saved: 0, unpaid: 0, advance: 0, ...inputs.vacation.days }
    const paidLike = days.paid + days.extraPaid + days.saved
    const priced = deriveVacationDaysPay({
      vacationRule: emp.vacationRule,
      salaryType: emp.salaryType,
      monthlySalary: monthlyAtDegree,
      semestertillaggRate,
      dailyDivisor: dailyDivisor(workdaysPerWeek),
      paidDaysPerDayOff: paidDaysPerDayOff(vacationDaysPerYear, workdaysPerWeek),
      days,
      procentregelnDayValue:
        emp.vacationRule === 'procentregeln' && paidLike > 0
          ? procentregelnDayValue({
              paymentDate: inputs.period.paymentDate,
              basis: inputs.vacation.basis ?? 'calendar',
              employmentStart: emp.employmentStart,
              employmentEnd: emp.employmentEnd ?? null,
              vacationDaysPerYear,
              vacationPayRate: emp.vacationPayRate ?? null,
              payslips: inputs.vacation.basisPayslips ?? [],
            })
          : undefined,
    })
    if (!priced.ok) throw new Error(`vacation days refused: ${priced.reason.en}`)
    vacationRows = priced.rows
    for (const row of priced.rows) {
      lineItems.push({
        itemType: 'vacation',
        amount: row.amount,
        isTaxable: true,
        isAvgiftBasis: true,
        isVacationBasis: row.is_vacation_basis,
        isGrossDeduction: row.is_gross_deduction,
        isNetDeduction: false,
      })
    }
  }

  // 8f. Engine.
  const table = emp.taxTable
  const column = emp.taxColumn ?? 1
  const result = calculateSalary(
    {
      employmentType: 'employee',
      salaryType: emp.salaryType,
      monthlySalary: hourly ? 0 : emp.monthlySalary,
      hourlyRate: emp.hourlyRate,
      hoursWorked: emp.hoursWorked,
      employmentDegree: degree,
      taxTableNumber: table,
      taxColumn: column,
      isSidoinkomst: false,
      jamkningPercentage: null,
      jamkningValidFrom: null,
      jamkningValidTo: null,
      fSkattStatus: 'a_skatt',
      personnummer: emp.personnummer,
      paymentDate: inputs.period.paymentDate,
      vacationRule: emp.vacationRule,
      vacationDaysPerYear,
      semestertillaggRate,
      vacationPayRate: emp.vacationPayRate ?? null,
      qualifyingAbsenceHours: absence.qualifyingAbsenceHours > 0 ? absence.qualifyingAbsenceHours : undefined,
      dailyDivisor: dailyDivisor(workdaysPerWeek),
      vaxaStodEligible: false,
      vaxaStodStart: null,
      vaxaStodEnd: null,
      lineItems,
      periodStart: inputs.period.start,
      periodEnd: inputs.period.end,
      employmentStart: emp.employmentStart,
      employmentEnd: emp.employmentEnd ?? null,
      roundNetToWholeKrona: inputs.roundNetToWholeKrona ?? false,
      calculationPolicy: policy,
    },
    CONFIG_2026,
    table ? taxRates2026(table, column) : [],
  )
  return { result, absence, vacationRows }
}

/** Sum amounts per key, rounded to öre, for comparing derived rows by type. */
export function sumBy<T>(rows: readonly T[], key: (row: T) => string, amount: (row: T) => number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const k = key(row)
    out[k] = roundOre((out[k] ?? 0) + amount(row))
  }
  return out
}

/**
 * The engine's figures for exactly the keys a scenario expects, so one
 * toEqual shows every mismatch of a payslip at once.
 */
export function actualFor(run: PayslipRun, expected: PayslipExpected): PayslipExpected {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(expected) as Array<keyof PayslipExpected>) {
    switch (key) {
      case 'absenceRows':
        out.absenceRows = sumBy(run.absence.lineItems, (li) => li.item_type, (li) => li.amount)
        break
      case 'vacationRows':
        out.vacationRows = sumBy(run.vacationRows, (row) => row.kind, (row) => row.amount)
        break
      case 'fkReporting':
        out.fkReporting = run.absence.flagFkReporting
        break
      case 'lakarintyg':
        out.lakarintyg = run.absence.flagLakarintyg
        break
      default:
        out[key] = run.result[key]
    }
  }
  return out as PayslipExpected
}
