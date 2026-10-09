import { roundOre } from '@/lib/money'
import { isFSkattStatus } from './declared-avgifter'
import { effectiveNetPayout } from './payment/effective-net'

/**
 * Effective per-employee payroll figures: what the booking, the AGI and the
 * bank file actually use once the review-step overrides (avancerat läge) are
 * applied. The stored salary_run_employees columns keep the engine's raw
 * values (the calculation trace needs them); every surface that SHOWS a
 * figure reads it through this module so a preview, a payslip read, a run
 * total and the lönejournal cannot disagree with the posted verifikat.
 *
 * The rules mirror salaryRunDataFromRows (salary-entries.ts), which feeds
 * the booking:
 *  - tax = tax_withheld_override ?? tax_withheld
 *  - net moves by the same amount the tax override moves it
 *    (effectiveNetPayout, the figure written into the payment file)
 *  - avgifter = avgifter_amount_override ?? avgifter_amount, except for
 *    F-skatt payees: they form no underlag for arbetsgivaravgifter, so the
 *    AGI and the booking ignore an avgifter override on such rows
 *    (isFSkattStatus) and so does this helper
 *  - employer cost = gross + avgifter + vacation accrual + its avgifter,
 *    the engine's own definition with the effective avgifter
 *
 * Pure (no server imports): the run page's KPI cards use it client-side.
 */
export interface EffectiveFiguresInput {
  gross_salary: number
  tax_withheld: number
  tax_withheld_override?: number | null
  net_salary: number
  avgifter_amount: number
  avgifter_amount_override?: number | null
  vacation_accrual: number
  vacation_accrual_avgifter: number
  employee?: { f_skatt_status?: string | null } | null
}

export interface EffectiveFigures {
  gross_salary: number
  tax_withheld: number
  net_salary: number
  avgifter_amount: number
  vacation_accrual: number
  employer_cost: number
  tax_overridden: boolean
  avgifter_overridden: boolean
}

export function effectiveRow(sre: EffectiveFiguresInput): EffectiveFigures {
  const gross = Number(sre.gross_salary) || 0
  const rawTax = Number(sre.tax_withheld) || 0
  const taxOverride = sre.tax_withheld_override ?? null
  const tax = taxOverride ?? rawTax
  const net = roundOre(
    effectiveNetPayout({
      net_salary: Number(sre.net_salary) || 0,
      tax_withheld: rawTax,
      tax_withheld_override: taxOverride,
    }),
  )
  const fSkatt = isFSkattStatus(sre.employee?.f_skatt_status)
  const avgifterOverride = fSkatt ? null : (sre.avgifter_amount_override ?? null)
  const avgifter = avgifterOverride ?? (Number(sre.avgifter_amount) || 0)
  const vacationAccrual = Number(sre.vacation_accrual) || 0
  const vacationAccrualAvgifter = Number(sre.vacation_accrual_avgifter) || 0
  return {
    gross_salary: gross,
    tax_withheld: tax,
    net_salary: net,
    avgifter_amount: avgifter,
    vacation_accrual: vacationAccrual,
    employer_cost: roundOre(gross + avgifter + vacationAccrual + vacationAccrualAvgifter),
    tax_overridden: taxOverride !== null,
    avgifter_overridden: avgifterOverride !== null,
  }
}

export interface EffectiveRunTotals {
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  total_employer_cost: number
}

/**
 * Run totals summed from the effective per-employee figures. Each step is
 * rounded to whole öre so a sum over many rows carries no binary drift.
 */
export function effectiveRunTotals(rows: EffectiveFiguresInput[]): EffectiveRunTotals {
  const totals: EffectiveRunTotals = {
    total_gross: 0,
    total_tax: 0,
    total_net: 0,
    total_avgifter: 0,
    total_vacation_accrual: 0,
    total_employer_cost: 0,
  }
  for (const sre of rows) {
    const eff = effectiveRow(sre)
    totals.total_gross = roundOre(totals.total_gross + eff.gross_salary)
    totals.total_tax = roundOre(totals.total_tax + eff.tax_withheld)
    totals.total_net = roundOre(totals.total_net + eff.net_salary)
    totals.total_avgifter = roundOre(totals.total_avgifter + eff.avgifter_amount)
    totals.total_vacation_accrual = roundOre(totals.total_vacation_accrual + eff.vacation_accrual)
    totals.total_employer_cost = roundOre(totals.total_employer_cost + eff.employer_cost)
  }
  return totals
}
