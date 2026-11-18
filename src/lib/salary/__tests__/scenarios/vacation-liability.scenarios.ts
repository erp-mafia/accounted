/**
 * Area b: valuation of the semesterlöneskuld (2920/2940).
 *
 * Runnable: the day value (dayValueSek, the estimate the year close, the MCP
 * vacation-balance tool and the v1 route share), the year-close preview
 * (previewVacationYearClose), the per-run accrual, the valuation on a date
 * (computeVacationLiability, vacation-liability-valuation.ts) with its
 * vacation_day_value conventions, and the remeasurement verifikat that books
 * the difference to 2920/2940 (buildRemeasurePlan, vacation-liability-plan.ts;
 * the 'remeasure' method books it at every run, "stäm av" on a date).
 */
import { roundOre } from '@/lib/money'
import { SRC, type Scenario, type SourceRef } from './catalogue'
import { Y2026, avgiftRate } from './formulas'
import type { PayslipExpected, PayslipInputs } from './harness'
import type { DayValueEmployee } from '../../semesterberedning'

export type DayValueInputs = DayValueEmployee

/** One employee's closing-year ledger row and master data, as previewVacationYearClose reads them. */
export interface YearCloseInputs {
  closingYearStart: string
  employee: {
    personnummer: string
    vacation_rule: 'sammaloneregeln' | 'procentregeln'
    monthly_salary: number
    vacation_days_per_year: number
    semestertillagg_rate: number | null
    vacation_pay_rate: number | null
  }
  ledger: { entitled_days: number; taken_days: number; saved_days: Record<string, number> }
  booked2920: number
  booked2940: number
  /**
   * The semesterunderlag the earning year's payslips booked (procentregeln).
   * The runner feeds it to the year close as twelve booked monthly payslips
   * of equal base in the closing year (the calendar basis earns and takes in
   * the same year), the shape procentregeln-liability.ts reads.
   */
  earningYearSemesterunderlag?: number
}

export interface YearCloseExpected {
  day_value_sek: number
  remaining_days?: number
  saveable_days?: number
  untaken_below_floor_days?: number
  saved_days_after?: Record<string, number>
  avgifter_rate?: number
  computed_liability: number
  computed_avgifter?: number
  drift_2920?: number
  drift_2940?: number
}

/** Monthly true-up: book the difference between the day-valued target and what 2920/2940 hold. */
export interface TrueUpInputs {
  month: string
  /** The valuation date: the month's last day. */
  asOfDate: string
  employees: Array<{
    label: string
    vacation_rule: 'sammaloneregeln' | 'procentregeln'
    monthly_salary: number
    semestertillagg_rate: number
    birthYear: number
    /**
     * Paid days still owed at month end (entitled + saved - taken). The
     * runner hands this count to the valuation as the employee's owed days:
     * how the engine counts days on a date (earned share under the calendar
     * basis, earning days under the statutory one) is the subject of VL-07,
     * VL-10 and vacation-liability-valuation.test.ts, not of the true-up.
     */
    remainingDays: number
  }>
  booked2920: number
  booked2940: number
}

export interface TrueUpExpected {
  dayValues: number[]
  target2920: number
  target2940: number
  /** Positive = debit 7290 / credit 2920 (and 7519 / 2940); negative = the reverse. */
  entry2920: number
  entry2940: number
}

/**
 * A day-value convention valued on a date: one sammalöneregeln employee with
 * `days` owed, under the company's vacation_day_value (salaryShare 0,046 is
 * percent_4_6). The K2 figures are the published example's assumptions.
 */
export interface ConventionInputs {
  asOfDate: string
  monthlySalary: number
  days: number
  salaryShare: number
  tillagg: number
  birthYear: number
  k2?: { avgifterRate: number; avtaladeAvgifter: number; pensionShare: number; slpRate: number }
}

export interface ConventionExpected {
  perDay: number
  liability: number
  /** Lagstadgade avgifter at the employee's tier rate of the settlement year. */
  avgifter: number
  /** K2 exempel 17 b also provisions avtalade avgifter and SLP on the pension part. */
  avtalade?: number
  slp?: number
}

export type LiabilityScenario =
  | Scenario<'day-value', DayValueInputs, { dayValue: number }>
  | Scenario<'year-close', YearCloseInputs, YearCloseExpected>
  | Scenario<'payslip', PayslipInputs, PayslipExpected>
  | Scenario<'true-up', TrueUpInputs, TrueUpExpected>
  | Scenario<'convention', ConventionInputs, ConventionExpected>

// ---------------------------------------------------------------------------
// Fixtures and expected-side valuation
// ---------------------------------------------------------------------------

const MONTHLY: DayValueInputs = {
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

/** Sammalöneregeln day value: dagslön (månadslön / 21) plus the tillägg, the sum rounded to öre. */
function sammaloneDayValue(monthly: number, tillagg: number): number {
  return roundOre(monthly / 21 + monthly * tillagg)
}

/** Procentregeln day value for a monthly salary: 12 × månadslön × rate / entitled days. */
function procentDayValue(monthly: number, rate: number, days = 25): number {
  return roundOre((12 * monthly * rate) / days)
}

const dayValueSources: SourceRef[] = [SRC.convDayValue, SRC.k2_1710]

function trueUp(inputs: TrueUpInputs): TrueUpExpected {
  const dayValues = inputs.employees.map((e) =>
    e.vacation_rule === 'sammaloneregeln'
      ? sammaloneDayValue(e.monthly_salary, e.semestertillagg_rate)
      : procentDayValue(e.monthly_salary, Y2026.procentregeln),
  )
  const liabilities = inputs.employees.map((e, i) => roundOre(e.remainingDays * dayValues[i]))
  const target2920 = roundOre(liabilities.reduce((s, l) => s + l, 0))
  const target2940 = roundOre(
    inputs.employees.reduce((s, e, i) => {
      const tier = e.birthYear <= 1937 ? 'exempt' : e.birthYear <= 1958 ? 'reduced' : 'standard'
      return s + roundOre(liabilities[i] * avgiftRate(tier))
    }, 0),
  )
  return {
    dayValues,
    target2920,
    target2940,
    entry2920: roundOre(target2920 - inputs.booked2920),
    entry2940: roundOre(target2940 - inputs.booked2940),
  }
}

const trueUpSources: SourceRef[] = [SRC.k2_1710, SRC.vacAccrual, SRC.convDayValue, SRC.seml16a1, SRC.remeasurePlan]

function liabilityScenarios(): LiabilityScenario[] {
  const list: LiabilityScenario[] = []

  // VL-01 to VL-04: day values -----------------------------------------------
  list.push({
    id: 'VL-01',
    title: 'Day value, sammalöneregeln 0,43 %: dagslön plus semestertillägg',
    area: 'vacation-liability',
    status: 'runnable',
    kind: 'day-value',
    inputs: MONTHLY,
    expected: { dayValue: sammaloneDayValue(30000, 0.0043) },
    formula: 'Day value = månadslön / 21 + månadslön × 0,43 % (the salary runs on per day off, plus the tillägg per betald dag).',
    sources: [...dayValueSources, SRC.seml16a1, SRC.seml16a, SRC.fortnoxProcent],
    anchors: [{ label: 'Fortnox: semestertillägg for 25 days at 30 000 kr, (30 000 × 0,43 %) × 25 = 3 225 kr', computed: roundOre(25 * roundOre(30000 * 0.0043)), published: 3225, tolerance: 0 }],
  })
  list.push({
    id: 'VL-02',
    title: 'Day value, procentregeln 12 %, monthly salary 40 000 kr',
    area: 'vacation-liability',
    status: 'runnable',
    kind: 'day-value',
    inputs: { ...MONTHLY, vacation_rule: 'procentregeln', monthly_salary: 40000 },
    expected: { dayValue: procentDayValue(40000, Y2026.procentregeln) },
    formula: 'Day value = 12 % × (12 × månadslön) / 25 entitled days.',
    sources: [...dayValueSources, SRC.seml16b, SRC.vacProcent],
  })
  list.push({
    id: 'VL-03',
    title: 'Day value, procentregeln at a kollektivavtal rate of 13 %',
    area: 'vacation-liability',
    status: 'runnable',
    kind: 'day-value',
    inputs: { ...MONTHLY, vacation_rule: 'procentregeln', monthly_salary: 40000, vacation_pay_rate: 0.13 },
    expected: { dayValue: procentDayValue(40000, 0.13) },
    formula: 'Day value = 13 % × (12 × månadslön) / 25: an agreement rate above the statutory 12 % replaces it.',
    sources: [...dayValueSources, SRC.seml16b],
  })
  list.push({
    id: 'VL-04',
    title: 'Day value, hourly employee under procentregeln (185 kr, 40 h a week)',
    area: 'vacation-liability',
    status: 'runnable',
    kind: 'day-value',
    inputs: { ...MONTHLY, vacation_rule: 'procentregeln', salary_type: 'hourly', monthly_salary: 0, hourly_rate: 185 },
    expected: { dayValue: roundOre((185 * 40 * 52 * Y2026.procentregeln) / 25) },
    formula: 'Day value = timlön × 40 h × 52 weeks × 12 % / 25.',
    sources: [...dayValueSources, SRC.seml16b],
  })

  // VL-05, VL-06, VL-17: the 4,6 % day-value convention (vacation_day_value = percent_4_6)
  {
    const k2 = { avgifterRate: 0.3, avtaladeAvgifter: 0.06, pensionShare: 0.05, slpRate: 0.24 }
    const inputs: ConventionInputs = { asOfDate: '2026-10-31', monthlySalary: 30000, days: 100, salaryShare: 0.046, tillagg: 0.008, birthYear: 1985, k2 }
    const perDay = roundOre(inputs.monthlySalary * (inputs.salaryShare + inputs.tillagg))
    const liability = roundOre(perDay * inputs.days)
    const avgifterK2 = roundOre(liability * k2.avgifterRate)
    const avtalade = roundOre(liability * k2.avtaladeAvgifter)
    const slp = roundOre(liability * k2.pensionShare * k2.slpRate)
    const k2Anchors = [
      { label: 'K2 17 b: semesterlöneskuld 162 000 kr', computed: liability, published: 162000, tolerance: 0 },
      { label: 'K2 17 b: arbetsgivaravgifter 48 600 kr (at the example\'s 30 %)', computed: avgifterK2, published: 48600, tolerance: 0 },
      { label: 'K2 17 b: avtalade avgifter 9 720 kr', computed: avtalade, published: 9720, tolerance: 0 },
      { label: 'K2 17 b: särskild löneskatt 1 944 kr', computed: slp, published: 1944, tolerance: 0 },
      { label: 'K2 17 b: total 222 264 kr', computed: roundOre(liability + avgifterK2 + avtalade + slp), published: 222264, tolerance: 0 },
    ]
    list.push({
      id: 'VL-05',
      title: 'K2 example 17 b: a vacation day valued at 5,4 % of månadslön (4,6 % lön + 0,8 % tillägg)',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'convention',
      inputs,
      expected: { perDay, liability, avgifter: roundOre(liability * Y2026.avgifterStandard) },
      formula:
        'Day value = månadslön × (4,6 % + tillägg) (vacation_day_value = percent_4_6, tillägg 0,8 %). Liability = day value × days owed; ' +
        'lagstadgade avgifter on it at the employee\'s 2026 tier rate (31,42 %), where the K2 example assumes 30 % (pinned in the anchors). ' +
        'The example\'s avtalade avgifter and SLP are VL-17.',
      sources: [SRC.k2_17b, SRC.k2_1710, SRC.avgifterTotal],
      anchors: k2Anchors,
    })
    list.push({
      id: 'VL-17',
      title: 'K2 example 17 b: avtalade avgifter (6 %) and SLP on the pension part provisioned with the semesterlöneskuld',
      area: 'vacation-liability',
      status: 'todo',
      todoReason: 'the valuation provisions only lagstadgade avgifter (2940); no avtalade avgifter or SLP on the liability',
      kind: 'convention',
      inputs,
      expected: { perDay, liability, avgifter: roundOre(liability * Y2026.avgifterStandard), avtalade, slp },
      formula: 'Avtalade avgifter = liability × 6 %; SLP = liability × pension share 5 % × 24 % (the example\'s särskild löneskatt rate).',
      sources: [SRC.k2_17b],
      anchors: k2Anchors,
    })
    const spiris: ConventionInputs = { asOfDate: '2026-10-31', monthlySalary: 30000, days: 10, salaryShare: 0.046, tillagg: 0.0043, birthYear: 1985 }
    const spirisDay = roundOre(spiris.monthlySalary * (spiris.salaryShare + spiris.tillagg))
    const spirisLiability = roundOre(spirisDay * spiris.days)
    list.push({
      id: 'VL-06',
      title: 'Sammalöneregeln day value as månadslön × (4,6 % + 0,43 %) (Spiris convention)',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'convention',
      inputs: spiris,
      expected: { perDay: spirisDay, liability: spirisLiability, avgifter: roundOre(spirisLiability * Y2026.avgifterStandard) },
      formula:
        'Day value = månadslön × (4,6 % + 0,43 %) under vacation_day_value = percent_4_6; the default daily_divisor gives ' +
        'månadslön / 21 + månadslön × 0,43 % (VL-01).',
      sources: [SRC.spirisSammalon, SRC.k2_17b, SRC.convDayValue4_6],
    })
  }

  // VL-07 to VL-11: the year-close preview ---------------------------------
  {
    const base: YearCloseInputs = {
      closingYearStart: '2025-01-01',
      employee: {
        personnummer: 'mock_born_1985',
        vacation_rule: 'sammaloneregeln',
        monthly_salary: 30000,
        vacation_days_per_year: 25,
        semestertillagg_rate: 0.0043,
        vacation_pay_rate: null,
      },
      ledger: { entitled_days: 25, taken_days: 10, saved_days: {} },
      booked2920: 10000,
      booked2940: 3142,
    }
    const dv = sammaloneDayValue(30000, 0.0043)
    const liability = roundOre(15 * dv)
    const avg = roundOre(liability * Y2026.avgifterStandard)
    list.push({
      id: 'VL-07',
      title: 'Year close after ten days taken: fifteen days owed, drift against the booked 2920/2940',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'year-close',
      inputs: base,
      expected: {
        day_value_sek: dv,
        remaining_days: 15,
        saveable_days: 5,
        untaken_below_floor_days: 10,
        avgifter_rate: Y2026.avgifterStandard,
        computed_liability: liability,
        computed_avgifter: avg,
        drift_2920: roundOre(liability - base.booked2920),
        drift_2940: roundOre(avg - base.booked2940),
      },
      formula:
        'Liability = (entitled − taken) × day value; avgifter on it at the settlement year\'s rate (31,42 %). Only days above 20 are saveable; ' +
        'the rest is flagged. Drift = target − booked, posted as one adjustment.',
      sources: [SRC.k2_1710, SRC.seml18, SRC.vacAccrual, SRC.convDayValue],
    })
    const raised = sammaloneDayValue(42000, 0.0043)
    list.push({
      id: 'VL-08',
      title: 'Sammalöneregeln after a raise to 42 000 kr: every owed day is revalued at the new salary',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'year-close',
      inputs: { ...base, employee: { ...base.employee, monthly_salary: 42000 } },
      expected: { day_value_sek: raised, computed_liability: roundOre(15 * raised) },
      formula: 'Semesterlön under sammalöneregeln is the månadslön current at the semestertillfälle, so the owed days are valued at 42 000 kr.',
      sources: [SRC.seml16a1, SRC.seml16a, SRC.k2_1710],
    })
    const earningYearSemesterunderlag = 12 * 40000
    const lawDay = roundOre((Y2026.procentregeln * earningYearSemesterunderlag) / 25)
    list.push({
      id: 'VL-09',
      title: 'Procentregeln after a raise from 40 000 to 42 000 kr: owed days keep the earning year\'s value',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'year-close',
      inputs: { ...base, employee: { ...base.employee, vacation_rule: 'procentregeln', monthly_salary: 42000 }, earningYearSemesterunderlag },
      expected: { day_value_sek: lawDay, computed_liability: roundOre(15 * lawDay) },
      formula:
        'Earning year 2025 paid 12 × 40 000 kr. Semesterlön = 12 % of that förfallen lön / 25 days, whatever the salary is when the days are taken. ' +
        'The raise to 42 000 kr changes next year\'s accrual, not the value of days already earned.',
      sources: [SRC.seml16b, SRC.seml7, SRC.k2_1710],
      note:
        'Was an engine bug: the year close valued a procentregeln day from the CURRENT monthly_salary (15 × 2 419,20 instead of ' +
        '15 × 2 304,00, 1 728 kr too much). Fixed: procentregeln-liability.ts prices owed days ' +
        'from the earning year\'s booked semesterunderlag, as the payout does.',
    })
    const savedDays = 3
    const savedRemaining = 7
    list.push({
      id: 'VL-10',
      title: 'Saved days: 7 untaken (5 saveable, 2 flagged) plus 3 saved from 2023, all valued at the current day value',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'year-close',
      inputs: { ...base, ledger: { entitled_days: 25, taken_days: 18, saved_days: { '2023': savedDays } } },
      expected: {
        day_value_sek: dv,
        remaining_days: savedRemaining,
        saveable_days: 5,
        untaken_below_floor_days: 2,
        saved_days_after: { '2023': savedDays, '2025': 5 },
        computed_liability: roundOre((savedRemaining + savedDays) * dv),
      },
      formula:
        'Days above 20 may be saved (max 25 − 20 = 5); saved days count as earned in the most recent intjänandeår, so they carry the same day value. ' +
        'Liability = (7 untaken + 3 saved) × day value.',
      sources: [SRC.seml18, SRC.seml22, SRC.vacSaved, SRC.convDayValue],
    })
    list.push({
      id: 'VL-11',
      title: 'Avgifter on the liability for an employee born 1958: 10,21 % in the settlement year 2026',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'year-close',
      inputs: { ...base, employee: { ...base.employee, personnummer: 'mock_born_1958' } },
      expected: {
        day_value_sek: dv,
        avgifter_rate: Y2026.avgifterReduced,
        computed_liability: liability,
        computed_avgifter: roundOre(liability * Y2026.avgifterReduced),
      },
      formula: 'The days are paid in 2026, when the employee is 67 at årets ingång: the provision uses 10,21 %, the rate of the payment year.',
      sources: [SRC.k2_1710, SRC.avgifterReduced, SRC.vacAccrual],
    })
  }

  // VL-12: the per-run accrual under sammalöneregeln --------------------------
  {
    const accrual = roundOre(40000 * Y2026.sammaloneTillagg * (25 / 12))
    list.push({
      id: 'VL-12',
      title: 'Monthly accrual under sammalöneregeln: the earned share of the semestertillägg only',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'payslip',
      inputs: {
        employee: {
          salaryType: 'monthly',
          monthlySalary: 40000,
          personnummer: '198504120000',
          taxTable: 33,
          vacationRule: 'sammaloneregeln',
          employmentStart: '2019-03-01',
        },
        period: { start: '2026-10-01', end: '2026-10-31', paymentDate: '2026-10-23' },
      },
      expected: { vacationAccrual: accrual, vacationAccrualAvgifter: roundOre(accrual * Y2026.avgifterStandard) },
      formula:
        'Accrual = månadslön × 0,43 % × 25 / 12 per month. The dagslön part of the day value (VL-01) is not accrued per run: ' +
        'under the accrual method it reaches 2920 only through the year-close drift; the remeasure method (VL-13 to VL-16) moves it every month.',
      sources: [SRC.convSammaloneAccrual, SRC.vacAccrual, SRC.seml16a],
    })
  }

  // VL-13 to VL-16: the monthly true-up (remeasure method, stäm av) -------------
  {
    const anna = { label: 'Anna', vacation_rule: 'sammaloneregeln' as const, monthly_salary: 30000, semestertillagg_rate: 0.0043, birthYear: 1985, remainingDays: 15 }
    const first: TrueUpInputs = { month: '2026-10', asOfDate: '2026-10-31', employees: [anna], booked2920: 20000, booked2940: 6284 }
    const firstExpected = trueUp(first)
    list.push({
      id: 'VL-13',
      title: 'Monthly true-up: 2920/2940 brought to the day-valued target at month end',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'true-up',
      inputs: first,
      expected: firstExpected,
      formula:
        'Target 2920 = Σ remaining paid days × day value per employee; target 2940 = Σ each liability × the employee\'s avgift rate. ' +
        'Entry = target − booked: debit 7290 / credit 2920 and debit 7519 / credit 2940 when positive, the reverse when negative. One verifikat per month.',
      sources: trueUpSources,
    })
    const afterRaise: TrueUpInputs = {
      month: '2026-11',
      asOfDate: '2026-11-30',
      employees: [{ ...anna, monthly_salary: 33000 }],
      booked2920: firstExpected.target2920,
      booked2940: firstExpected.target2940,
    }
    list.push({
      id: 'VL-14',
      title: 'True-up the month after a raise to 33 000 kr: all fifteen owed days revalued',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'true-up',
      inputs: afterRaise,
      expected: trueUp(afterRaise),
      formula: 'Booked = last month\'s target. New target at 33 000 kr; the entry is the revaluation only (sammalöneregeln follows the current salary).',
      sources: [...trueUpSources, SRC.seml16a1],
    })
    const afterVacation: TrueUpInputs = {
      month: '2026-11',
      asOfDate: '2026-11-30',
      employees: [{ ...anna, remainingDays: 10 }],
      booked2920: firstExpected.target2920,
      booked2940: firstExpected.target2940,
    }
    list.push({
      id: 'VL-15',
      title: 'True-up after five vacation days taken: the liability falls by five day values',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'true-up',
      inputs: afterVacation,
      expected: trueUp(afterVacation),
      formula: 'Remaining 10 days. The entry is negative: debit 2920 / credit 7290 and debit 2940 / credit 7519.',
      sources: trueUpSources,
    })
    const perRunAccruals = roundOre(9 * roundOre(30000 * Y2026.sammaloneTillagg * (25 / 12)))
    const switchOn: TrueUpInputs = {
      month: '2026-10',
      asOfDate: '2026-10-31',
      employees: [{ ...anna, remainingDays: 20 }],
      booked2920: perRunAccruals,
      booked2940: roundOre(perRunAccruals * Y2026.avgifterStandard),
    }
    list.push({
      id: 'VL-16',
      title: 'Switching the true-up on in October: one catch-up entry for everything the per-run accruals never booked',
      area: 'vacation-liability',
      status: 'runnable',
      kind: 'true-up',
      inputs: switchOn,
      expected: trueUp(switchOn),
      formula:
        `2920 holds only nine months of tillägg accruals (9 × månadslön × 0,43 % × 25 / 12 = ${perRunAccruals}). ` +
        'The first true-up books target − booked in one verifikat dated in the first open period, never in a locked one (PROCESS.md P8).',
      sources: [...trueUpSources, SRC.convSammaloneAccrual],
    })
  }

  return list
}

export const LIABILITY_SCENARIOS: LiabilityScenario[] = liabilityScenarios()
