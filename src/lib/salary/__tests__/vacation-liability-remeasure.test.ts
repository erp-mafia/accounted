/**
 * Semesterlöneskuld remeasurement, the pure pieces: which days are owed on a
 * date (vacationLiabilityDays), what a day is worth (dayValueSek, the
 * procentregeln earning year), the avgifter tier, and the verifikat the
 * difference to the booked balance becomes (buildRemeasurePlan).
 */
import { describe, expect, it, vi } from 'vitest'

// Only decryption is mocked ('mock_born_YYYY' is a mid-year birth in YYYY);
// the age-tier math is the real one.
vi.mock('@/lib/salary/personnummer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/personnummer')>('@/lib/salary/personnummer')
  return {
    ...actual,
    decryptPersonnummer: (encrypted: string) => {
      const m = /^mock_born_(\d{4})$/.exec(encrypted)
      if (!m) throw new Error('not an encrypted fixture')
      return `${m[1]}06151234`
    },
  }
})

import { roundOre } from '@/lib/money'
import { dayValueSek, type DayValueEmployee } from '../semesterberedning'
import { liabilityAvgifterRate, liabilitySettlementYear, vacationLiabilityDays } from '../vacation-liability-days'
import { computeEntitledDays } from '../vacation-ledger'
import { procentregelnLiabilitySek, procentregelnLiabilityValue } from '../procentregeln-liability'
import { buildRemeasurePlan } from '../vacation-liability-plan'
import type { VacationLiabilityEmployeeValue, VacationLiabilityValuation } from '../vacation-liability-valuation'
import type { ProcentregelnBasisPayslip } from '../vacation-days-pay'

const MONTHLY: DayValueEmployee = {
  vacation_rule: 'sammaloneregeln',
  vacation_days_per_year: 25,
  vacation_pay_rate: null,
  salary_type: 'monthly',
  monthly_salary: 30000,
  employment_degree: 100,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
  semestertillagg_rate: 0.0043,
}

describe('vacationLiabilityDays', () => {
  const base = {
    vacationDaysPerYear: 25,
    employmentStart: '2020-01-01',
    employmentEnd: null,
    savedDays: 0,
  }

  it('calendar basis: the earned share of the year minus days taken', () => {
    const days = vacationLiabilityDays({
      ...base,
      basis: 'calendar',
      yearStart: '2026-01-01',
      asOfDate: '2026-06-30',
      entitledDays: 25,
      takenDays: 5,
    })
    // 181 of 365 days passed: 12,3973 days earned, 5 taken.
    expect(days.current_year_days).toBeCloseTo(25 * (181 / 365) - 5, 4)
    expect(days.earning_days).toBe(0)
  })

  it('calendar basis: on the year end the whole entitlement is earned (the figure the close has always valued)', () => {
    const days = vacationLiabilityDays({
      ...base,
      basis: 'calendar',
      yearStart: '2026-01-01',
      asOfDate: '2026-12-31',
      entitledDays: 25,
      takenDays: 18,
      savedDays: 3,
    })
    expect(days).toEqual({ current_year_days: 7, current_year_earned_days: 25, saved_days: 3, earning_days: 0, unclosed_year_days: 0, total_days: 10 })
  })

  it('calendar basis: a förskott (more taken than earned) is not netted, the employee owes 0 days, saved days still count', () => {
    const days = vacationLiabilityDays({
      ...base,
      basis: 'calendar',
      yearStart: '2026-01-01',
      asOfDate: '2026-03-31',
      entitledDays: 25,
      takenDays: 15,
      savedDays: 2,
    })
    expect(days.current_year_days).toBe(0)
    expect(days.total_days).toBe(2)
  })

  it('calendar basis: a hire during the year earns the entitlement over the employed part of the year', () => {
    const days = vacationLiabilityDays({
      ...base,
      employmentStart: '2026-07-01',
      basis: 'calendar',
      yearStart: '2026-01-01',
      asOfDate: '2026-09-30',
      entitledDays: 25,
      takenDays: 0,
    })
    // 92 of the 184 employed days have passed.
    expect(days.current_year_days).toBe(12.5)
  })

  it('statutory basis: the semesterår\'s untaken days plus the days earned so far toward the next one (7 §)', () => {
    const days = vacationLiabilityDays({
      ...base,
      basis: 'statutory_apr_mar',
      yearStart: '2026-04-01',
      asOfDate: '2026-09-30',
      entitledDays: 25,
      takenDays: 10,
      unclosedYearDays: 1,
    })
    expect(days.current_year_days).toBe(15)
    // 1 April to 30 September: 183 of 365 days.
    expect(days.earning_days).toBeCloseTo((183 / 365) * 25, 4)
    expect(days.unclosed_year_days).toBe(1)
    expect(days.total_days).toBeCloseTo(15 + (183 / 365) * 25 + 1, 3)
  })

  it('statutory basis: on the last day of the intjänandeår the next year\'s days are earned in full, rounded up like 7 §', () => {
    const days = vacationLiabilityDays({
      ...base,
      employmentStart: '2026-06-10',
      basis: 'statutory_apr_mar',
      yearStart: '2026-04-01',
      asOfDate: '2027-03-31',
      entitledDays: 0,
      takenDays: 0,
    })
    // 294 of 365 days employed: 20,14 days, rounded up to 21.
    expect(days.earning_days).toBe(21)
  })
})

describe('avgifter on the liability', () => {
  it('provisions at the rates of the year after the valuation date', () => {
    expect(liabilitySettlementYear('2026-06-30')).toBe(2026)
    expect(liabilitySettlementYear('2026-12-31')).toBe(2027)
    expect(liabilitySettlementYear('2027-03-31')).toBe(2027)
  })

  it('a 67+ employee is provisioned at the ålderspensionsavgift only, from the year they have turned 67 at its start', () => {
    // Born mid-1959: 66 at the start of 2026, 67 at the start of 2027.
    expect(liabilityAvgifterRate('mock_born_1959', 2026)).toBe(0.3142)
    expect(liabilityAvgifterRate('mock_born_1959', 2027)).toBe(0.1021)
    expect(liabilityAvgifterRate('mock_born_1937', 2027)).toBe(0)
    expect(liabilityAvgifterRate('mock_born_1990', 2027)).toBe(0.3142)
    expect(liabilityAvgifterRate(null, 2027)).toBe(0.3142)
    expect(liabilityAvgifterRate('garbage', 2027)).toBe(0.3142)
  })
})

describe('dayValueSek: sammalöneregeln day value conventions', () => {
  it('daily_divisor: månadslön / 21 plus the tillägg (the historical value)', () => {
    expect(dayValueSek(MONTHLY)).toBe(roundOre(30000 / 21 + 30000 * 0.0043))
    expect(dayValueSek(MONTHLY, 'daily_divisor')).toBe(1557.57)
  })

  it('percent_4_6: 4,6 % of the månadslön plus the tillägg (K2 exempel 17 b)', () => {
    expect(dayValueSek(MONTHLY, 'percent_4_6')).toBe(roundOre(30000 * 0.046 + 30000 * 0.0043))
    expect(dayValueSek({ ...MONTHLY, semestertillagg_rate: 0.008 }, 'percent_4_6')).toBe(roundOre(30000 * 0.054))
  })

  it('part-time: a day is worth a day of the pay actually earned', () => {
    const halfTime = { ...MONTHLY, employment_degree: 50 }
    expect(dayValueSek(halfTime)).toBe(roundOre(15000 / 21 + 15000 * 0.0043))
    expect(dayValueSek(halfTime, 'percent_4_6')).toBe(roundOre(15000 * 0.046 + 15000 * 0.0043))
  })

  it('percent_4_6 is per paid day whatever the week: four days a week gives the same day value', () => {
    expect(dayValueSek({ ...MONTHLY, workdays_per_week: 4 }, 'percent_4_6')).toBe(dayValueSek(MONTHLY, 'percent_4_6'))
  })

  it('a raise revalues every day owed under sammalöneregeln: the semesterlön is the salary when the leave is taken', () => {
    const before = dayValueSek(MONTHLY)
    const after = dayValueSek({ ...MONTHLY, monthly_salary: 33000 })
    expect(after).toBe(roundOre(33000 / 21 + 33000 * 0.0043))
    expect(after).toBeGreaterThan(before)
  })
})

/** Twelve procentregeln payslips of `basis` each, paid the 25th from `fromMonth`. */
function payslips(fromYear: number, fromMonth: number, count: number, basis: number, status = 'booked'): ProcentregelnBasisPayslip[] {
  return Array.from({ length: count }, (_, i) => {
    const month = ((fromMonth - 1 + i) % 12) + 1
    const year = fromYear + Math.floor((fromMonth - 1 + i) / 12)
    return {
      salaryRunId: `run-${year}-${month}`,
      paymentDate: `${year}-${String(month).padStart(2, '0')}-25`,
      status,
      vacationBasis: basis,
    }
  })
}

describe('procentregeln: days valued on the earning year\'s pay (Semesterlagen 16 b §)', () => {
  const employee = {
    id: 'emp-1',
    vacation_days_per_year: 25,
    vacation_pay_rate: null,
    employment_start: '2020-01-01',
    employment_end: null,
  }

  it('VL-09: an earning year of 12 x 40 000 and a salary of 42 000 now, 15 days owed: 2 304 a day, 34 560 kr', () => {
    const value = procentregelnLiabilityValue({
      employee,
      basis: 'calendar',
      asOfDate: '2026-06-30',
      payslips: payslips(2025, 1, 12, 40000),
    })
    expect(value.perDay).toBe(2304)
    const estimate = dayValueSek({ ...MONTHLY, vacation_rule: 'procentregeln', monthly_salary: 42000 })
    expect(estimate).toBe(2419.2)
    const days = { current_year_days: 15, saved_days: 0, earning_days: 0, unclosed_year_days: 0, total_days: 15 }
    expect(procentregelnLiabilitySek(days, value, estimate)).toEqual({ dayValue: 2304, valuedDays: 15, liability: 34560, fromEarningYear: true })
    // The estimate from today's salary would have overstated 2920 by 1 728 kr.
    expect(roundOre(15 * estimate)).toBe(36288)
  })

  it('falls back to the estimate from today\'s pay when Accounted lacks a month of the earning year', () => {
    const value = procentregelnLiabilityValue({
      employee,
      basis: 'calendar',
      asOfDate: '2026-06-30',
      payslips: payslips(2025, 1, 11, 40000),
    })
    expect(value.perDay).toBeNull()
    const days = { current_year_days: 10, saved_days: 0, earning_days: 0, unclosed_year_days: 0, total_days: 10 }
    expect(procentregelnLiabilitySek(days, value, 2419.2)).toEqual({ dayValue: 2419.2, valuedDays: 10, liability: 24192, fromEarningYear: false })
  })

  it('hourly pay, statutory basis: the owed days at the earning year\'s day value plus 12 % of this year\'s semesterunderlag so far', () => {
    const hourly = { ...employee, id: 'emp-hourly' }
    const value = procentregelnLiabilityValue({
      employee: hourly,
      basis: 'statutory_apr_mar',
      asOfDate: '2026-09-30',
      // Earning year April 2025 to March 2026: 12 x 20 000; this year April to September: 6 x 22 000.
      payslips: [...payslips(2025, 4, 12, 20000), ...payslips(2026, 4, 6, 22000)],
    })
    expect(value.perDay).toBe(roundOre((0.12 * 240000) / 25))
    expect(value.earningSek).toBe(roundOre(0.12 * 132000))
    const days = { current_year_days: 20, saved_days: 0, earning_days: 12.5342, unclosed_year_days: 0, total_days: 32.5342 }
    const sek = procentregelnLiabilitySek(days, value, 9999)
    expect(sek.liability).toBe(roundOre(20 * 1152 + 15840))
    expect(sek.fromEarningYear).toBe(true)
  })

  it('a month of this year without a booked payslip makes the running part an estimate; the run being booked counts', () => {
    const slips = [...payslips(2025, 4, 12, 20000), ...payslips(2026, 4, 5, 22000), ...payslips(2026, 9, 1, 22000, 'paid')]
    const without = procentregelnLiabilityValue({ employee, basis: 'statutory_apr_mar', asOfDate: '2026-09-30', payslips: slips })
    // September's run is paid but not booked: not counted, and August is the
    // last month that must be there, so the year is still known.
    expect(without.earningSek).toBe(roundOre(0.12 * 110000))
    const inFlight = procentregelnLiabilityValue({
      employee,
      basis: 'statutory_apr_mar',
      asOfDate: '2026-09-30',
      payslips: slips,
      inFlightRunId: 'run-2026-9',
    })
    expect(inFlight.earningSek).toBe(roundOre(0.12 * 132000))
    const gap = procentregelnLiabilityValue({
      employee,
      basis: 'statutory_apr_mar',
      asOfDate: '2026-09-30',
      payslips: slips.filter((p) => p.paymentDate !== '2026-06-25'),
    })
    expect(gap.earningSek).toBeNull()
  })
})

describe('procentregeln: a hire during a sammanfallande calendar year (Semesterlagen 7 §, 16 b §)', () => {
  // 35 000 kr a month from 1 June 2026, paid the 25th.
  const hire = { id: 'emp-hire', vacation_days_per_year: 25, vacation_pay_rate: null, employment_start: '2026-06-01', employment_end: null }
  // Today's-pay estimate: 35 000 x 12 x 12 % / 25.
  const ESTIMATE = 2016
  const calendarDays = (asOfDate: string, takenDays = 0, employmentStart = '2026-06-01') =>
    vacationLiabilityDays({
      basis: 'calendar',
      yearStart: '2026-01-01',
      asOfDate,
      entitledDays: computeEntitledDays('calendar', '2026-01-01', 25, employmentStart),
      takenDays,
      savedDays: 0,
      vacationDaysPerYear: 25,
      employmentStart,
      employmentEnd: null,
    })

  it('the year end: 15 days earned, worth 12 % of the seven months\' pay, 29 400 kr', () => {
    const value = procentregelnLiabilityValue({ employee: hire, basis: 'calendar', asOfDate: '2026-12-31', payslips: payslips(2026, 6, 7, 35000) })
    // The payout has no day value for a year not wholly employed (unchanged);
    // the running year's semesterlön is 12 % x 245 000.
    expect(value).toEqual({ basis: 'calendar', perDay: null, earningSek: 29400 })
    const days = calendarDays('2026-12-31')
    expect(days.current_year_days).toBe(15)
    expect(days.current_year_earned_days).toBe(15)
    expect(procentregelnLiabilitySek(days, value, ESTIMATE)).toEqual({ dayValue: 1960, valuedDays: 15, liability: 29400, fromEarningYear: true })
    // Before: the flat 25 days at the estimate, 50 400 kr.
    expect(roundOre(25 * ESTIMATE)).toBe(50400)
  })

  it('mid-year: the semesterlön of the pay fallen due so far, over the days earned so far', () => {
    const value = procentregelnLiabilityValue({ employee: hire, basis: 'calendar', asOfDate: '2026-09-30', payslips: payslips(2026, 6, 4, 35000) })
    expect(value.earningSek).toBe(16800)
    const days = calendarDays('2026-09-30')
    // 122 of the 214 employed days have passed: 15 x 122 / 214.
    expect(days.current_year_earned_days).toBe(8.5514)
    const sek = procentregelnLiabilitySek(days, value, ESTIMATE)
    expect(sek.dayValue).toBe(roundOre(16800 / 8.5514))
    // Priced per day like the payout: within an öre of the 16 800 earned.
    expect(sek.liability).toBe(16799.99)
    expect(sek.fromEarningYear).toBe(true)
  })

  it('days taken were paid: the rest of the earned semesterlön stays owed', () => {
    const value = procentregelnLiabilityValue({ employee: hire, basis: 'calendar', asOfDate: '2026-12-31', payslips: payslips(2026, 6, 7, 35000) })
    expect(procentregelnLiabilitySek(calendarDays('2026-12-31', 5), value, ESTIMATE)).toEqual({
      dayValue: 1960,
      valuedDays: 10,
      liability: 19600,
      fromEarningYear: true,
    })
  })

  it('a month without a booked payslip: today\'s pay stands in over the 15 days, flagged', () => {
    const slips = payslips(2026, 6, 7, 35000).filter((p) => p.paymentDate !== '2026-08-25')
    const value = procentregelnLiabilityValue({ employee: hire, basis: 'calendar', asOfDate: '2026-12-31', payslips: slips })
    expect(value.earningSek).toBeNull()
    expect(procentregelnLiabilitySek(calendarDays('2026-12-31'), value, ESTIMATE)).toEqual({
      dayValue: ESTIMATE,
      valuedDays: 15,
      liability: 30240,
      fromEarningYear: false,
    })
  })

  it('an employee of the whole previous year keeps the payout\'s day value, at the year end and mid-year', () => {
    const veteran = { ...hire, id: 'emp-veteran', employment_start: '2020-01-01' }
    const yearEnd = procentregelnLiabilityValue({ employee: veteran, basis: 'calendar', asOfDate: '2026-12-31', payslips: payslips(2026, 1, 12, 35000) })
    expect(procentregelnLiabilitySek(calendarDays('2026-12-31', 0, '2020-01-01'), yearEnd, ESTIMATE)).toEqual({
      dayValue: 2016,
      valuedDays: 25,
      liability: 50400,
      fromEarningYear: true,
    })
    // Mid-year after a raise: last year's 2 304 a day, as the payout pays them, not this year's 12 %.
    const midYear = procentregelnLiabilityValue({
      employee: veteran,
      basis: 'calendar',
      asOfDate: '2026-09-30',
      payslips: [...payslips(2025, 1, 12, 40000), ...payslips(2026, 1, 9, 42000)],
    })
    const days = calendarDays('2026-09-30', 0, '2020-01-01')
    expect(procentregelnLiabilitySek(days, midYear, ESTIMATE)).toEqual({
      dayValue: 2304,
      valuedDays: roundOre(days.total_days),
      liability: roundOre(days.total_days * 2304),
      fromEarningYear: true,
    })
  })

  it('an employee of the whole previous year whose payslips for it are not in Accounted: mid-year the running year\'s pay values the days, the year end the payout\'s day value', () => {
    const veteran = { ...hire, id: 'emp-veteran', employment_start: '2020-01-01' }
    const midYear = procentregelnLiabilityValue({ employee: veteran, basis: 'calendar', asOfDate: '2026-09-30', payslips: payslips(2026, 1, 9, 35000) })
    expect(midYear).toEqual({ basis: 'calendar', perDay: null, earningSek: 37800 })
    const days = calendarDays('2026-09-30', 0, '2020-01-01')
    const sek = procentregelnLiabilitySek(days, midYear, ESTIMATE)
    expect(sek.dayValue).toBe(roundOre(37800 / days.current_year_earned_days!))
    // 12 % of the nine months' pay, within an öre, and no longer called an estimate.
    expect(Math.abs(sek.liability - 37800)).toBeLessThanOrEqual(0.05)
    expect(sek.fromEarningYear).toBe(true)
    // The year end has the whole year: the payout's day value, the same 2 016.
    const yearEnd = procentregelnLiabilityValue({ employee: veteran, basis: 'calendar', asOfDate: '2026-12-31', payslips: payslips(2026, 1, 12, 35000) })
    expect(procentregelnLiabilitySek(calendarDays('2026-12-31', 0, '2020-01-01'), yearEnd, ESTIMATE)).toEqual({
      dayValue: 2016,
      valuedDays: 25,
      liability: 50400,
      fromEarningYear: true,
    })
  })

  it('days of an earlier year not closed yet keep the estimate beside the running year\'s value', () => {
    const days = { current_year_days: 10, current_year_earned_days: 10, saved_days: 0, earning_days: 0, unclosed_year_days: 3, total_days: 13 }
    const value = { basis: 'calendar' as const, perDay: null, earningSek: 20000 }
    expect(procentregelnLiabilitySek(days, value, ESTIMATE)).toEqual({
      dayValue: ESTIMATE,
      valuedDays: 3,
      liability: roundOre(3 * ESTIMATE + 10 * 2000),
      fromEarningYear: false,
    })
  })

  it('statutory basis, a hire whose only owed days are still being earned: the same 29 400 kr, no longer called an estimate', () => {
    const value = procentregelnLiabilityValue({ employee: hire, basis: 'statutory_apr_mar', asOfDate: '2026-12-31', payslips: payslips(2026, 6, 7, 35000) })
    expect(value).toEqual({ basis: 'statutory_apr_mar', perDay: null, earningSek: 29400 })
    const days = vacationLiabilityDays({
      basis: 'statutory_apr_mar',
      yearStart: '2026-04-01',
      asOfDate: '2026-12-31',
      entitledDays: computeEntitledDays('statutory_apr_mar', '2026-04-01', 25, '2026-06-01'),
      takenDays: 0,
      savedDays: 0,
      vacationDaysPerYear: 25,
      employmentStart: '2026-06-01',
      employmentEnd: null,
    })
    expect(days.current_year_days).toBe(0)
    expect(days.earning_days).toBe(14.6575)
    expect(procentregelnLiabilitySek(days, value, ESTIMATE)).toEqual({ dayValue: ESTIMATE, valuedDays: 0, liability: 29400, fromEarningYear: true })
  })
})

function value(over: Partial<VacationLiabilityEmployeeValue> & { employee_id: string }): VacationLiabilityEmployeeValue {
  return {
    employee_name: over.employee_id,
    vacation_rule: 'sammaloneregeln',
    liability_change_account: '7290',
    default_dimensions: null,
    days: { current_year_days: 0, saved_days: 0, earning_days: 0, unclosed_year_days: 0, total_days: 0 },
    day_value_sek: 0,
    valued_days: 0,
    earning_sek: 0,
    day_value_basis: 'current_pay',
    variable_vacation_pay_sek: 0,
    computed_liability_sek: 0,
    avgifter_rate: 0.3142,
    computed_avgifter_sek: 0,
    ...over,
  }
}

function valuation(rows: VacationLiabilityEmployeeValue[]): VacationLiabilityValuation {
  return {
    as_of_date: '2026-10-25',
    basis: 'calendar',
    vacation_year_start: '2026-01-01',
    day_value_policy: 'daily_divisor',
    settlement_year: 2026,
    rows,
    totals: {
      computed_liability: roundOre(rows.reduce((s, r) => s + r.computed_liability_sek, 0)),
      computed_avgifter: roundOre(rows.reduce((s, r) => s + r.computed_avgifter_sek, 0)),
    },
  }
}

function spec(employeeId: string, accruedAmount: number, accruedAvgifter: number, account: '7090' | '7290' = '7290') {
  return { employeeId, employeeName: employeeId, accruedAmount, accruedAvgifter, liabilityChangeAccount: account }
}

const lineOf = (plan: ReturnType<typeof buildRemeasurePlan>, account: string) =>
  plan.lines.filter((l) => l.account_number === account)

describe('buildRemeasurePlan: the verifikat of the difference', () => {
  it('first catch-up: the accrued balance is topped up to the computed liability', () => {
    const plan = buildRemeasurePlan(
      valuation([value({ employee_id: 'a', computed_liability_sek: 14000, computed_avgifter_sek: 4398.8 })]),
      [spec('a', 10000, 3142)],
      { booked2920: 10000, booked2940: 3142 },
    )
    expect(plan.difference_2920).toBe(4000)
    expect(plan.difference_2940).toBe(1256.8)
    expect(plan.lines).toEqual([
      { account_number: '7290', debit_amount: 4000, credit_amount: 0, line_description: 'Semesterlöneskuld, förändring' },
      { account_number: '2920', debit_amount: 0, credit_amount: 4000, line_description: 'Semesterlöneskuld, förändring' },
      { account_number: '7519', debit_amount: 1256.8, credit_amount: 0, line_description: 'Sociala avgifter på semesterlöneskuld, förändring' },
      { account_number: '2940', debit_amount: 0, credit_amount: 1256.8, line_description: 'Sociala avgifter på semesterlöneskuld, förändring' },
    ])
  })

  it('vacation taken: the liability falls, so 2920 is debited and the cost account credited', () => {
    const plan = buildRemeasurePlan(
      valuation([value({ employee_id: 'a', computed_liability_sek: 6000, computed_avgifter_sek: 1885.2 })]),
      [spec('a', 14000, 4398.8)],
      { booked2920: 14000, booked2940: 4398.8 },
    )
    expect(lineOf(plan, '2920')).toEqual([
      { account_number: '2920', debit_amount: 8000, credit_amount: 0, line_description: 'Semesterlöneskuld, förändring' },
    ])
    expect(lineOf(plan, '7290')[0]).toMatchObject({ debit_amount: 0, credit_amount: 8000 })
    expect(lineOf(plan, '2940')[0]).toMatchObject({ debit_amount: 2513.6, credit_amount: 0 })
  })

  it('books each employee on their own category: an arbetare\'s leave credits 7090, a tjänsteman\'s earning debits 7290', () => {
    const plan = buildRemeasurePlan(
      valuation([
        value({ employee_id: 'arbetare', liability_change_account: '7090', computed_liability_sek: 9500 }),
        value({ employee_id: 'tjansteman', computed_liability_sek: 10500 }),
      ]),
      [spec('arbetare', 10000, 0, '7090'), spec('tjansteman', 10000, 0)],
      { booked2920: 20000, booked2940: 0 },
    )
    expect(lineOf(plan, '7090')[0]).toMatchObject({ debit_amount: 0, credit_amount: 500 })
    expect(lineOf(plan, '7290')[0]).toMatchObject({ debit_amount: 500, credit_amount: 0 })
    // The two cancel on 2920: no liability line.
    expect(lineOf(plan, '2920')).toEqual([])
  })

  it('what 2920 holds beyond the employees\' shares is spread pro rata, so the voucher lands on the computed total', () => {
    const plan = buildRemeasurePlan(
      valuation([
        value({ employee_id: 'a', computed_liability_sek: 3000 }),
        value({ employee_id: 'b', computed_liability_sek: 1000 }),
      ]),
      [spec('a', 3000, 0), spec('b', 1000, 0)],
      // A manual entry put 400 kr more on 2920 than the runs explain.
      { booked2920: 4400, booked2940: 0 },
    )
    expect(plan.difference_2920).toBe(-400)
    expect(plan.rows.map((r) => r.adjustment_2920)).toEqual([-300, -100])
    expect(lineOf(plan, '2920')[0]).toMatchObject({ debit_amount: 400, credit_amount: 0 })
  })

  it('splits the cost side per dimensions bag, the liability stays one line', () => {
    const plan = buildRemeasurePlan(
      valuation([
        value({ employee_id: 'a', computed_liability_sek: 1000, default_dimensions: { '1': 'STHLM' } }),
        value({ employee_id: 'b', computed_liability_sek: 2000, default_dimensions: { '1': 'GBG' } }),
      ]),
      [],
      { booked2920: 0, booked2940: 0 },
    )
    const costs = lineOf(plan, '7290')
    expect(costs.map((l) => [l.dimensions, l.debit_amount])).toEqual([
      [{ '1': 'GBG' }, 2000],
      [{ '1': 'STHLM' }, 1000],
    ])
    expect(lineOf(plan, '2920')).toEqual([
      { account_number: '2920', debit_amount: 0, credit_amount: 3000, line_description: 'Semesterlöneskuld, förändring' },
    ])
  })

  it('books nothing within a krona (öre noise is no verifikat)', () => {
    const plan = buildRemeasurePlan(
      valuation([value({ employee_id: 'a', computed_liability_sek: 10000.6, computed_avgifter_sek: 3142.2 })]),
      [spec('a', 10000, 3142)],
      { booked2920: 10000, booked2940: 3142 },
    )
    expect(plan.lines).toEqual([])
    expect(plan.difference_2920).toBe(0.6)
  })

  it('a liability with nobody behind it books on 7290 without dimensions', () => {
    const plan = buildRemeasurePlan(valuation([]), [], { booked2920: 2500, booked2940: 0 })
    expect(plan.lines).toEqual([
      { account_number: '7290', debit_amount: 0, credit_amount: 2500, line_description: 'Semesterlöneskuld, förändring' },
      { account_number: '2920', debit_amount: 2500, credit_amount: 0, line_description: 'Semesterlöneskuld, förändring' },
    ])
  })

  it('every voucher balances', () => {
    const plan = buildRemeasurePlan(
      valuation([
        value({ employee_id: 'a', liability_change_account: '7090', computed_liability_sek: 1234.56, computed_avgifter_sek: 387.9 }),
        value({ employee_id: 'b', computed_liability_sek: 7654.32, computed_avgifter_sek: 781.51, avgifter_rate: 0.1021 }),
      ]),
      [spec('a', 1000, 314.2, '7090'), spec('b', 5000, 510.5)],
      { booked2920: 6100.01, booked2940: 830 },
    )
    const debit = roundOre(plan.lines.reduce((s, l) => s + l.debit_amount, 0))
    const credit = roundOre(plan.lines.reduce((s, l) => s + l.credit_amount, 0))
    expect(debit).toBe(credit)
    expect(debit).toBeGreaterThan(0)
  })
})
