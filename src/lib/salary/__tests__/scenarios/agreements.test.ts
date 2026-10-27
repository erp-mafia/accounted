/**
 * Area c of the payroll scenario catalogue: kollektivavtal scenarios
 * (agreements.scenarios.ts holds the data and the sources).
 *
 * Premium scenarios run computePremiumLines (shift-premium-engine.ts) on the
 * rules' engine encodings, priced from premiumPayBasis as run-calculation.ts
 * prices them. The comparison is per agreement rule: hours exactly, amounts
 * within the rounding the agreements leave open (see amountTolerance).
 * Agreement sick pay from day 15 is todo; the karens comparisons run today.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ShiftPremiumRule } from '@/types'
import { roundOre } from '@/lib/money'
import { computePremiumLines, premiumPayBasis, type WorkedDayShift } from '../../shift-premium-engine'
import { scenarioTestName } from './catalogue'
import { minutes } from './formulas'
import { runPayslip } from './harness'
import { AGREEMENT_SCENARIOS, type AgreementRule, type AgreementScenario, type PremiumExpected, type PremiumInputs } from './agreements.scenarios'

vi.mock('@/lib/salary/personnummer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/personnummer')>()
  return { ...actual, decryptPersonnummer: (value: string) => value }
})

const EMPLOYEE_ID = 'scenario-employee'

/** The rule's shift_premium_rules rows: one per window, `<rule id>#<n>`. */
function engineRows(rule: AgreementRule): ShiftPremiumRule[] {
  const enc = rule.engine
  if (!enc) return []
  return enc.windows.map((w, n) => ({
    id: `${rule.id}#${n}`,
    company_id: 'scenario-company',
    name: rule.label,
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    day_of_week: w.days,
    start_time: w.start,
    end_time: w.end,
    amount_form: rule.form === 'kr_per_hour' ? 'sek_per_hour' : rule.form,
    premium_percent: rule.form === 'percent_of_hourly' ? rule.value : null,
    monthly_divisor: rule.form === 'monthly_divisor' ? rule.value : null,
    sek_per_hour: rule.form === 'kr_per_hour' ? rule.value : null,
    hourly_divisor: rule.form === 'percent_of_hourly' ? (enc.hourlyDivisor ?? null) : null,
    valid_from: rule.validFrom ?? null,
    valid_to: rule.validTo ?? null,
    item_type: enc.itemType,
    priority: enc.priority ?? 0,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: null,
  }))
}

/** Worked hours of a shift; an end at or before the start runs past midnight. */
function shiftHours(start: string, end: string): number {
  const s = minutes(start)
  const e = minutes(end) <= s ? minutes(end) + 24 * 60 : minutes(end)
  return (e - s) / 60
}

/**
 * The agreements prescribe no rounding. The expectation rounds the rate per
 * hour to öre and then the line (up to 0,5 öre per hour plus 0,5 öre); the
 * engine multiplies first and rounds once (0,5 öre).
 */
function amountTolerance(hours: number): number {
  return 0.005 * hours + 0.01
}

type PerRule = Record<string, { hours: number; amount: number }>

function add(into: PerRule, rule: string, hours: number, amount: number): void {
  const cur = into[rule] ?? { hours: 0, amount: 0 }
  into[rule] = { hours: roundOre(cur.hours + hours), amount: roundOre(cur.amount + amount) }
}

function runPremium(inputs: PremiumInputs, expected: PremiumExpected): void {
  const pay = premiumPayBasis({
    salary_type: 'monthly',
    hourly_rate: null,
    monthly_salary: inputs.monthlySalary,
    employment_degree: 100,
    hours_per_week: inputs.hoursPerWeek,
  })
  const workedDays: WorkedDayShift[] = inputs.shifts.map((sh) => ({
    work_date: sh.date,
    hours: shiftHours(sh.start, sh.end),
    start_time: sh.start,
    end_time: sh.end,
  }))
  const lines = computePremiumLines({
    employeeId: EMPLOYEE_ID,
    baseHourlyRate: pay.hourlyRate,
    monthlySalary: pay.monthlySalary,
    workedDays,
    rules: inputs.rules.flatMap(engineRows),
  })

  const actual: PerRule = {}
  for (const l of lines) add(actual, l.sourceRuleId.split('#')[0], l.hours, l.amount)

  const byId = new Map(inputs.rules.map((r) => [r.id, r]))
  const want: PerRule = {}
  for (const l of expected.lines) {
    const rule = byId.get(l.rule)
    if (!rule) throw new Error(`expected line names unknown rule ${l.rule}`)
    if (!rule.engine) {
      // The timlön of an overtime hour is pay for the hour, not a premium.
      if (rule.kind !== 'overtime_hourly_pay') throw new Error(`${l.rule} has no engine encoding`)
      continue
    }
    add(want, l.rule, l.hours, l.amount)
  }

  // The same rules (one the agreement does not pay on these hours, such as
  // OB on overtime, must not appear), the same hours, amounts within rounding.
  expect(Object.keys(actual).sort()).toEqual(Object.keys(want).sort())
  for (const [rule, w] of Object.entries(want)) {
    expect(actual[rule].hours, `${rule} hours`).toBe(w.hours)
    const diff = Math.abs(actual[rule].amount - w.amount)
    expect(diff, `${rule}: engine ${actual[rule].amount} kr, agreement ${w.amount} kr`).toBeLessThanOrEqual(amountTolerance(w.hours))
  }
  for (const np of expected.notPaid) {
    if (!expected.lines.some((l) => l.rule === np.rule)) expect(actual[np.rule], `${np.rule}: ${np.reason}`).toBeUndefined()
  }
}

function runScenario(s: AgreementScenario): void {
  switch (s.kind) {
    case 'karens-compare': {
      const run = runPayslip(s.inputs.payslip)
      const sickRows = run.absence.lineItems.filter((li) => li.item_type === 'sick_karens' || li.item_type === 'sick_day2_14')
      const deduction = -sickRows.reduce((sum, li) => sum + li.amount, 0)
      expect(Math.abs(s.expected.teknik - s.expected.almega)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(deduction - s.expected.teknik)).toBeLessThanOrEqual(s.expected.toleranceSek)
      expect(Math.abs(deduction - s.expected.almega)).toBeLessThanOrEqual(s.expected.toleranceSek)
      return
    }
    case 'premium':
      runPremium(s.inputs, s.expected)
      return
    case 'sick-topup':
      throw new Error(`${s.id}: no runner for agreement sick pay from day 15`)
  }
}

describe('payroll scenarios, area c: kollektivavtal', () => {
  for (const s of AGREEMENT_SCENARIOS) {
    const name = scenarioTestName(s)
    if (s.status === 'todo') it.todo(name)
    // SCENARIO_SHOW_BUGS=1 runs the suspected engine bugs as plain tests, to see the diff.
    else if (s.status === 'engine-bug' && !process.env.SCENARIO_SHOW_BUGS) it.fails(`${name} [suspected engine bug, see note]`, () => runScenario(s))
    else it(name, () => runScenario(s))
  }
})
