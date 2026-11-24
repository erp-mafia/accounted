/**
 * The value of the procentregeln part of the semesterlöneskuld, from the
 * semesterlönegrundande lön the days were earned on rather than today's
 * salary.
 *
 * Semesterlagen 16 b §: semesterlön under procentregeln is twelve per cent
 * (or the agreed rate) of the semesterlönegrundande lön of the intjänandeår;
 * 22 §: sparade dagar count as earned in the most recent intjänandeår. The
 * payout path already prices a day that way (procentregelnDayValue in
 * vacation-days-pay.ts); a liability valued from the current månadslön
 * (dayValueSek's estimate) overstates it after a raise and understates it
 * after a cut, so the books and the payout disagree. Example: an earning
 * year of 12 x 40 000, a salary of 42 000 now and 15 days owed: 2 304 a day,
 * 34 560 kr, where the estimate gives 2 419,20 a day, 36 288 kr.
 *
 * Two values per employee, as of a date:
 *   - perDay: one paid day of the days owed (the vacation year's remaining
 *     days, sparade dagar), priced the way the payout prices a day taken the
 *     day after the date (procentregelnDayValue with that payment date): the
 *     year before that day's semesterår is the earning year. Mid-year that is
 *     the base the year's days are paid on; on the last day of a vacation year
 *     it is the year just ended, the base the rolled days are paid on.
 *     null when Accounted does not hold that whole year (a new company, a
 *     cutover, a hire during the year): the caller falls back to the
 *     estimate.
 *   - earningSek: the semesterlön of the days being earned in the running
 *     intjänandeår, the rate times the semesterunderlag of the payslips paid
 *     in it so far (16 b § exactly; the same figure the per-run accrual
 *     books). The running intjänandeår is the running vacation year on
 *     either basis: on the statutory one it earns the next semesterår's days,
 *     under sammanfallande semesterår (calendar) its own. null when a month
 *     the employee was employed has passed without a counted payslip in
 *     Accounted.
 *
 * Counted payslips: booked, or the run being booked (`inFlightRunId`). The
 * earning year's base follows procentregelnDayValue's own rule (approved,
 * paid or booked), as the payout does.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import { loadProcentregelnBasisPayslips, procentregelnDayValue, type ProcentregelnBasisPayslip } from './vacation-days-pay'
import { resolveVacationPayRate } from './vacation-pay-rate'
import { getVacationYearStart, type VacationYearBasis } from './vacation-year'
import { previousVacationYearStart } from './variable-vacation-pay'
import type { VacationLiabilityDays } from './vacation-liability-days'
import { roundPaidDays } from './vacation-net-days'

export interface ProcentregelnLiabilityValue {
  basis: VacationYearBasis
  perDay: number | null
  earningSek: number | null
}

export interface ProcentregelnEmployee {
  id: string
  vacation_days_per_year: number
  vacation_pay_rate: number | null
  employment_start: string
  employment_end: string | null
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function monthsFrom(fromIso: string, toMonth: string): string[] {
  const months: string[] = []
  let year = Number(fromIso.slice(0, 4))
  let month = Number(fromIso.slice(5, 7))
  while (`${year}-${String(month).padStart(2, '0')}` <= toMonth) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

/** The month before `iso`'s month, as YYYY-MM. */
function previousMonth(iso: string): string {
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

/** One employee's values from their payslips. Pure. */
export function procentregelnLiabilityValue(input: {
  employee: ProcentregelnEmployee
  basis: VacationYearBasis
  asOfDate: string
  payslips: readonly ProcentregelnBasisPayslip[]
  inFlightRunId?: string
}): ProcentregelnLiabilityValue {
  const { employee, basis, asOfDate } = input
  const rate = resolveVacationPayRate(employee.vacation_days_per_year, employee.vacation_pay_rate)
  const day = procentregelnDayValue({
    paymentDate: addDays(asOfDate, 1),
    basis,
    employmentStart: employee.employment_start,
    employmentEnd: employee.employment_end,
    vacationDaysPerYear: employee.vacation_days_per_year,
    vacationPayRate: employee.vacation_pay_rate,
    payslips: input.payslips,
  })

  const runningStart = getVacationYearStart(asOfDate, basis)
  const counted = input.payslips.filter(
    (p) =>
      (p.status === 'booked' || p.salaryRunId === input.inFlightRunId) &&
      p.paymentDate >= runningStart &&
      p.paymentDate <= asOfDate,
  )
  // Every month the employee was employed that has fully passed needs a
  // counted payslip calculated under procentregeln; the running month may
  // still be unpaid.
  const employedFrom = employee.employment_start > runningStart ? employee.employment_start : runningStart
  const lastMonth = previousMonth(asOfDate)
  const employedTo = employee.employment_end && employee.employment_end.slice(0, 7) < lastMonth ? employee.employment_end.slice(0, 7) : lastMonth
  const paidMonths = new Set(counted.filter((p) => p.vacationBasis !== null).map((p) => p.paymentDate.slice(0, 7)))
  const missing = employedFrom.slice(0, 7) <= employedTo ? monthsFrom(employedFrom, employedTo).filter((m) => !paidMonths.has(m)) : []
  const earningSek = missing.length > 0 ? null : roundOre(rate * sumOre(counted.map((p) => p.vacationBasis ?? 0)))
  return { basis, perDay: day.known ? day.perDay : null, earningSek }
}

/**
 * The values for the given procentregeln employees as of a date: their
 * payslips from the start of the earning year of the day after the date (and
 * of the running year) up to and including the date.
 */
export async function loadProcentregelnLiabilityValues(
  supabase: SupabaseClient,
  args: {
    companyId: string
    basis: VacationYearBasis
    asOfDate: string
    employees: readonly ProcentregelnEmployee[]
    inFlightRunId?: string
  },
): Promise<Map<string, ProcentregelnLiabilityValue>> {
  const values = new Map<string, ProcentregelnLiabilityValue>()
  if (args.employees.length === 0) return values
  const dayAfter = addDays(args.asOfDate, 1)
  const earningYearStart = previousVacationYearStart(getVacationYearStart(dayAfter, args.basis))
  const runningStart = getVacationYearStart(args.asOfDate, args.basis)
  const from = earningYearStart < runningStart ? earningYearStart : runningStart
  const payslips = await loadProcentregelnBasisPayslips(supabase, {
    companyId: args.companyId,
    employeeIds: args.employees.map((e) => e.id),
    from,
    to: dayAfter,
  })
  for (const employee of args.employees) {
    values.set(
      employee.id,
      procentregelnLiabilityValue({
        employee,
        basis: args.basis,
        asOfDate: args.asOfDate,
        payslips: payslips.get(employee.id) ?? [],
        inFlightRunId: args.inFlightRunId,
      }),
    )
  }
  return values
}

export interface ProcentregelnLiabilitySek {
  /** What one valued day is worth. */
  dayValue: number
  /** The days priced at dayValue; the rest of the liability is the running intjänandeår's semesterlön. */
  valuedDays: number
  liability: number
  /** No day was priced at the estimate from today's pay. */
  fromEarningYear: boolean
}

/**
 * A procentregeln employee's liability: the days owed at the earning year's
 * day value, plus on the statutory basis the running intjänandeår's
 * semesterlön. Under sammanfallande semesterår (calendar) the payout prices
 * the running year's days at the previous year's day value, so the liability
 * does too; where the payout has none (the employee was not employed the
 * whole previous year, or Accounted lacks its payslips) the running year's
 * own days are worth its semesterlön so far over the days it has earned
 * (16 b §, 7 §). Where Accounted lacks the running year's pay too, the
 * estimate from today's pay (dayValueSek) stands in. Pure.
 */
export function procentregelnLiabilitySek(
  days: VacationLiabilityDays,
  value: ProcentregelnLiabilityValue | undefined,
  estimateDayValue: number,
): ProcentregelnLiabilitySek {
  const earnedDays = days.current_year_earned_days ?? 0
  if (value?.basis === 'calendar' && value.perDay == null && value.earningSek != null && days.current_year_days > 0 && earnedDays > 0) {
    const runningDayValue = roundOre(value.earningSek / earnedDays)
    const otherDays = roundPaidDays(days.total_days - days.current_year_days)
    if (otherDays <= 0) {
      return { dayValue: runningDayValue, valuedDays: days.total_days, liability: roundOre(days.total_days * runningDayValue), fromEarningYear: true }
    }
    // Sparade dagar or an earlier year not closed yet: those days keep the estimate.
    return {
      dayValue: estimateDayValue,
      valuedDays: otherDays,
      liability: roundOre(otherDays * estimateDayValue + days.current_year_days * runningDayValue),
      fromEarningYear: false,
    }
  }
  const dayValue = value?.perDay ?? estimateDayValue
  const owedDays = days.total_days - days.earning_days
  const earning = days.earning_days > 0 ? (value?.earningSek ?? days.earning_days * estimateDayValue) : 0
  return {
    dayValue,
    valuedDays: roundOre(owedDays),
    liability: roundOre(owedDays * dayValue + earning),
    fromEarningYear: (value?.perDay != null || owedDays <= 0) && (days.earning_days === 0 || value?.earningSek != null),
  }
}
