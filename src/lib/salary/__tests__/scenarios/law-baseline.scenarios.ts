/**
 * Area a: the law baseline. Companies without a kollektivavtal (almost all
 * of them) are paid by these rules, so every scenario here runs against the
 * engine today. A scenario whose source the engine does not follow is kept
 * with status engine-bug and a note, never adjusted to the engine.
 */
import { roundOre } from '@/lib/money'
import { SRC, at, type Scenario } from './catalogue'
import {
  Y2026,
  addDays,
  avgiftRate,
  avgifter,
  avgiftTier2026,
  calendarDays,
  dagslon,
  datesBetween,
  kalenderdagslon,
  karensavdragHourly,
  karensavdragMonthly,
  oneOffTax,
  tableTax,
  timlonAnnual,
  weekdaysBetween,
  type AvgiftTier,
} from './formulas'
import {
  absenceDays,
  benefitLine,
  netDeductionLine,
  sickDay,
  wageLine,
  type EmployeeSpec,
  type PayslipExpected,
  type PayslipInputs,
} from './harness'
import type { ProcentregelnBasisPayslip } from '../../vacation-days-pay'
import type { DeclaredAvgifterRow } from '../../declared-avgifter'

export interface ProcentregelnDayValueInputs {
  paymentDate: string
  vacationDaysPerYear: number
  vacationPayRate: number | null
  employmentStart: string
  payslips: ProcentregelnBasisPayslip[]
}

export interface DeclaredAvgifterInputs {
  rows: DeclaredAvgifterRow[]
}

export type LawScenario =
  | Scenario<'payslip', PayslipInputs, PayslipExpected>
  | Scenario<'procentregeln-day-value', ProcentregelnDayValueInputs, { perDay: number }>
  | Scenario<'declared-avgifter', DeclaredAvgifterInputs, { totalUnderlag: number; totalAmount: number }>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** October 2026: Mon-Fri only, no weekday public holiday (Alla helgons dag is Saturday 31 October). */
const OCT = { start: '2026-10-01', end: '2026-10-31', paymentDate: '2026-10-23' }

/** Tjänsteman, 40 000 kr, full time, born 1985, tax table 33 column 1, procentregeln 25 days. */
const ANNA: EmployeeSpec = {
  salaryType: 'monthly',
  monthlySalary: 40000,
  personnummer: '198504120000',
  taxTable: 33,
  taxColumn: 1,
  vacationRule: 'procentregeln',
  employmentStart: '2019-03-01',
}

/** Same shape at 36 000 kr: the sick, VAB and parental scenarios. */
const BERTIL: EmployeeSpec = { ...ANNA, monthlySalary: 36000, personnummer: '198811020000' }

/** The earning year 2025 under the calendar basis: twelve booked payslips with a procentregeln base. */
function earningYear2025(monthlyBases: number[]): ProcentregelnBasisPayslip[] {
  return monthlyBases.map((vacationBasis, i) => ({
    salaryRunId: `run-2025-${String(i + 1).padStart(2, '0')}`,
    paymentDate: `2025-${String(i + 1).padStart(2, '0')}-25`,
    status: 'booked',
    vacationBasis,
  }))
}

const birthYear = (pnr: string) => Number(pnr.slice(0, 4))

/** Gross-to-net expectation for one payslip (processing order: SKILL.md gross-to-net). */
function totals(p: {
  employee: EmployeeSpec
  paymentDate: string
  gross: number
  benefits?: number
  oneOff?: { amount: number; percent: number; rounding?: 'truncate' | 'nearest' }
  netDeductions?: number
  vacationAccrual: number
  /** Leave out the accrual avgifter (youth: the provision rate is the payment year's, not asserted here). */
  skipAccrualAvgifter?: boolean
}): PayslipExpected {
  const tier: AvgiftTier = avgiftTier2026(birthYear(p.employee.personnummer), p.paymentDate)
  const benefits = p.benefits ?? 0
  const taxable = roundOre(p.gross + benefits)
  const regular = p.oneOff ? roundOre(taxable - p.oneOff.amount) : taxable
  const table = p.employee.taxTable
  if (table === null) throw new Error('scenario needs a tax table')
  const tax =
    tableTax(table, p.employee.taxColumn ?? 1, regular) +
    (p.oneOff ? oneOffTax(p.oneOff.amount, p.oneOff.percent, p.oneOff.rounding) : 0)
  return {
    grossSalary: p.gross,
    benefitValues: benefits,
    taxableIncome: taxable,
    taxWithheld: tax,
    netSalary: roundOre(p.gross - tax - (p.netDeductions ?? 0)),
    avgifterRate: avgiftRate(tier),
    avgifterAmount: avgifter(taxable, tier),
    vacationAccrual: p.vacationAccrual,
    ...(p.skipAccrualAvgifter ? {} : { vacationAccrualAvgifter: roundOre(p.vacationAccrual * avgiftRate(tier)) }),
  }
}

/** Calendar day number inside a sjuklöneperiod that started on `first` (day 1 = first). */
const sickDayIndex = (first: string, date: string) => datesBetween(first, date).length

// Shared sick-pay figures for BERTIL (36 000 kr, 40 h, 5 days).
const D36 = dagslon(36000)
const KARENS36 = karensavdragMonthly(36000)
/** Lost pay minus 80 % sjuklön for n scheduled days, dagslön convention. */
const sickNetDeduction = (n: number) => roundOre(roundOre(n * D36) - roundOre(D36 * Y2026.sjuklonRate * n))

const sickSources = [SRC.sickKarens, SRC.sickOnePerPeriod, SRC.sickDay2to14, SRC.convDailyDivisor]

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function lawScenarios(): LawScenario[] {
  const list: LawScenario[] = []

  // LB-01 ------------------------------------------------------------------
  list.push({
    id: 'LB-01',
    title: 'Full month, monthly tjänsteman, procentregeln',
    area: 'law-baseline',
    status: 'runnable',
    kind: 'payslip',
    inputs: { employee: ANNA, period: OCT },
    expected: totals({ employee: ANNA, paymentDate: OCT.paymentDate, gross: 40000, vacationAccrual: roundOre(40000 * Y2026.procentregeln) }),
    formula:
      'Bruttolön = månadslön. Skatt = SKV 434 table 33 column 1 at the gross. Avgifter = 31,42 % of the gross. ' +
      'Semesteravsättning = 12 % of the semesterlönegrundande pay; avgifter on it at 31,42 %.',
    sources: [SRC.avgifterTotal, SRC.skv434, SRC.taxTableLookup, SRC.seml16b, SRC.vacProcent, SRC.vacAccrual],
  })

  // LB-02, LB-03: partial month start ----------------------------------------
  {
    const start = '2026-10-12'
    const employee: EmployeeSpec = { ...ANNA, employmentStart: start }
    const employed = weekdaysBetween(start, OCT.end).length
    const inMonth = weekdaysBetween(OCT.start, OCT.end).length
    const base = roundOre((40000 * employed) / inMonth)
    list.push({
      id: 'LB-02',
      title: 'Partial month: employment starts 12 October, partial_month = workdays',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT },
      expected: totals({ employee, paymentDate: OCT.paymentDate, gross: base, vacationAccrual: roundOre(base * Y2026.procentregeln) }),
      formula: `Grundlön = månadslön × Mon-Fri days employed (${employed}) / Mon-Fri days in October (${inMonth}), rounded to öre.`,
      sources: [SRC.convPartialWorkdays, SRC.seml16b],
    })
    const calendar = calendarDays(start, OCT.end)
    const baseCal = roundOre(kalenderdagslon(40000) * calendar)
    list.push({
      id: 'LB-03',
      title: 'Partial month: employment starts 12 October, partial_month = annual_calendar_days',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT, policy: { partial_month: 'annual_calendar_days' } },
      expected: totals({ employee, paymentDate: OCT.paymentDate, gross: baseCal, vacationAccrual: roundOre(baseCal * Y2026.procentregeln) }),
      formula: `Grundlön = (månadslön × 12 / 365, rounded to öre) × calendar days employed (${calendar}).`,
      sources: [SRC.convPartialCalendar, SRC.seml16b],
    })
  }

  // LB-04, LB-05: three sick days under both sick_rate conventions ------------
  {
    const days = ['2026-10-06', '2026-10-07', '2026-10-08']
    const sickRows = days.map((d) => sickDay(d))
    const row214 = sickNetDeduction(3)
    const gross = roundOre(36000 - row214 - KARENS36)
    list.push({
      id: 'LB-04',
      title: 'Sick Tuesday to Thursday, karensavdrag, sick_rate = daily_divisor',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: sickRows } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross, vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214, sick_karens: -KARENS36 },
        fkReporting: false,
        lakarintyg: false,
      },
      formula:
        'Avdrag = 3 × dagslön (månadslön / 21) less sjuklön 80 % of it, plus one karensavdrag = 20 % × 80 % × månadslön × 12 / 52. ' +
        'Sick days are semesterlönegrundande, so the procentregeln base keeps the full månadslön.',
      sources: [...sickSources, SRC.seml17, SRC.seml16b3],
    })
    const hourly = timlonAnnual(36000, 40)
    const sickHourly = roundOre(hourly * Y2026.sjuklonRate)
    const lost = roundOre(hourly * 24)
    const sjuklon = roundOre(sickHourly * 24)
    const row214Hourly = roundOre(lost - sjuklon)
    const grossHourly = roundOre(36000 - row214Hourly - KARENS36)
    list.push({
      id: 'LB-05',
      title: 'Sick Tuesday to Thursday, karensavdrag, sick_rate = annual_hourly',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, policy: { sick_rate: 'annual_hourly' }, absence: { periodDays: sickRows } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: grossHourly, vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214Hourly, sick_karens: -KARENS36 },
      },
      formula:
        'Timlön = månadslön × 12 / (52 × 40), rounded to öre; sjuklön per timme = 80 % of it, rounded to öre. ' +
        'Avdrag = 24 h × timlön less 24 h × sjuklön per timme, plus the same karensavdrag as LB-04.',
      sources: [SRC.convSickAnnualHourly, SRC.sickKarens, SRC.sickDay2to14],
    })
  }

  // LB-06: karensavdrag anchor ------------------------------------------------
  {
    const employee: EmployeeSpec = { ...BERTIL, monthlySalary: 30000 }
    const d = dagslon(30000)
    const karens = karensavdragMonthly(30000)
    const row214 = roundOre(d - roundOre(d * Y2026.sjuklonRate))
    list.push({
      id: 'LB-06',
      title: 'Karensavdrag for 30 000 kr matches the published example (about 1 108 kr)',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT, absence: { periodDays: [sickDay('2026-10-06')] } },
      expected: {
        ...totals({ employee, paymentDate: OCT.paymentDate, gross: roundOre(30000 - row214 - karens), vacationAccrual: roundOre(30000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214, sick_karens: -karens },
      },
      formula: 'Karensavdrag = 30 000 × 12 / 52 × 80 % × 20 %. One sick day: the karensavdrag is smaller than that day\'s sjuklön, so it is taken in full.',
      sources: [SRC.sickKarens],
      anchors: [{ label: 'sick-pay.md: karensavdrag ≈ 1 108 kr at 30 000 kr', computed: karens, published: 1108, tolerance: 0.5 }],
    })
  }

  // LB-07, LB-08: sickness crossing day 15 -----------------------------------
  {
    const first = '2026-09-21'
    const lookback = weekdaysBetween(first, '2026-09-30').map((d) => sickDay(d))
    const periodDates = weekdaysBetween('2026-10-01', '2026-10-16')
    const sjuklonDates = periodDates.filter((d) => sickDayIndex(first, d) <= 14)
    const fkDates = periodDates.filter((d) => sickDayIndex(first, d) >= 15)
    const row214 = sickNetDeduction(sjuklonDates.length)
    const row15 = roundOre(fkDates.length * D36)
    const accrual = roundOre(36000 * Y2026.procentregeln)
    list.push({
      id: 'LB-07',
      title: 'Sickness from 21 September crosses day 15 in October, long_leave = workdays',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: periodDates.map((d) => sickDay(d)), lookbackSickDays: lookback } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214 - row15), vacationAccrual: accrual }),
        absenceRows: { sick_day2_14: -row214, sick_day15_plus: -row15 },
        fkReporting: true,
        lakarintyg: true,
      },
      formula:
        `Days 1-14 of the sjuklöneperiod (from ${first}) get 80 % sjuklön: ${sjuklonDates.length} October weekdays. ` +
        `From day 15 (${addDays(first, 14)}) Försäkringskassan pays and the employer deducts a full dagslön: ${fkDates.length} weekdays. ` +
        'The karensavdrag was taken in September and is not repeated. Day 8+ needs läkarintyg; day 15+ is reported to Försäkringskassan.',
      sources: [SRC.sickDay2to14, SRC.sickOnePerPeriod, SRC.sickLakarintyg, SRC.sickDay15, SRC.convDailyDivisor],
    })
    const fkCalendar = calendarDays(fkDates[0], fkDates[fkDates.length - 1])
    const row15Cal = roundOre(kalenderdagslon(36000) * fkCalendar)
    list.push({
      id: 'LB-08',
      title: 'Sickness crossing day 15, long_leave = calendar_after_five_workdays (day 15+ per calendar day)',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: {
        employee: BERTIL,
        period: OCT,
        policy: { long_leave: 'calendar_after_five_workdays' },
        absence: { periodDays: periodDates.map((d) => sickDay(d)), lookbackSickDays: lookback },
      },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214 - row15Cal), vacationAccrual: accrual }),
        absenceRows: { sick_day2_14: -row214, sick_day15_plus: -row15Cal },
        fkReporting: true,
      },
      formula: `Day 15+ deducts (månadslön × 12 / 365, rounded to öre) per calendar day, weekends included: ${fkCalendar} days.`,
      sources: [SRC.convLongLeaveCalendar, SRC.sickDay15],
    })
  }

  // LB-09, LB-10: återinsjuknande inside and outside five days ---------------
  {
    const row214 = sickNetDeduction(2)
    list.push({
      id: 'LB-09',
      title: 'Sick again within five calendar days: one sjuklöneperiod, one karensavdrag',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: [sickDay('2026-10-06'), sickDay('2026-10-09')] } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214 - KARENS36), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214, sick_karens: -KARENS36 },
      },
      formula: 'Sick 6 October, well 7-8, sick 9 October (3 days after): the same sjuklöneperiod continues, so one karensavdrag only.',
      sources: [SRC.sickAterinsjuknande, SRC.sickOnePerPeriod],
    })
    const oneDaySjuklon = roundOre(D36 * Y2026.sjuklonRate)
    const karensEach = Math.min(KARENS36, oneDaySjuklon)
    list.push({
      id: 'LB-10',
      title: 'Sick again after more than five calendar days: two sjuklöneperioder, two karensavdrag',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: [sickDay('2026-10-06'), sickDay('2026-10-13')] } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214 - 2 * karensEach), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214, sick_karens: -roundOre(2 * karensEach) },
      },
      formula: 'Sick 6 October and again 13 October (7 days after): a new sjuklöneperiod with its own karensavdrag, each capped at that period\'s sjuklön.',
      sources: [SRC.sickAterinsjuknande, SRC.sickOnePerPeriod, SRC.sickKarens],
    })
  }

  // LB-11: återinsjuknande counts sick days, not elapsed days ----------------
  {
    const firstSpell = weekdaysBetween('2026-10-05', '2026-10-14')
    const secondSpell = weekdaysBetween('2026-10-19', '2026-10-23')
    // Sick calendar days already used by the first spell (weekend inside it included).
    const used = calendarDays('2026-10-05', '2026-10-14')
    const remaining = 14 - used
    const secondSjuklon = secondSpell.filter((d) => sickDayIndex('2026-10-19', d) <= remaining)
    const secondFk = secondSpell.filter((d) => sickDayIndex('2026-10-19', d) > remaining)
    const sjuklonDays = firstSpell.length + secondSjuklon.length
    const row214 = sickNetDeduction(sjuklonDays)
    const row15 = roundOre(secondFk.length * D36)
    list.push({
      id: 'LB-11',
      title: 'Återinsjuknande: the continued sjuklöneperiod counts sick days, not the healthy days in between',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: [...firstSpell, ...secondSpell].map((d) => sickDay(d)) } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214 - KARENS36 - row15), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214, sick_karens: -KARENS36, sick_day15_plus: -row15 },
      },
      formula:
        `First spell 5-14 October uses ${used} sick calendar days. Well 15-18 October. Sick again 19 October (5 days after): ` +
        `a continuation, so ${remaining} days of the sjuklöneperiod remain (19-${18 + remaining} October at 80 %) and only ` +
        `${secondFk.length} day (23 October) is day 15. One karensavdrag.`,
      sources: [SRC.sickAterinsjuknande, at(SRC.sickDay2to14, { at: '3-5' }), { kind: 'statute', ref: 'Lag (1991:1047) om sjuklön 7 §', quote: 'the new sick period is a continuation of the earlier sjuklöneperiod (återinsjuknande within five calendar days)' }],
      note:
        'Was an engine bug: the engine numbered sick rows by calendar days elapsed since 5 October, so the healthy days 15-18 October ' +
        'consumed sjuklöneperiod days. Fixed: derive-absence-line-items.ts numbers the ' +
        '14 days over sick spells only.',
    })
  }

  // LB-12: allmänt högriskskydd ---------------------------------------------
  {
    const lookback = ['2026-01-13', '2026-01-27', '2026-02-10', '2026-02-24', '2026-03-10', '2026-03-24', '2026-04-07', '2026-04-21', '2026-05-05', '2026-05-19'].map((d) =>
      sickDay(d),
    )
    const row214 = sickNetDeduction(1)
    list.push({
      id: 'LB-12',
      title: 'Allmänt högriskskydd: the 11th sjuklöneperiod in twelve months has no karensavdrag',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: [sickDay('2026-10-06')], lookbackSickDays: lookback } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - row214), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: -row214 },
      },
      formula: 'Ten single-day sjuklöneperioder January to May 2026 each took a karensavdrag; the one on 6 October is the 11th within twelve months, so no karensavdrag.',
      sources: [SRC.sickOnePerPeriod],
    })
  }

  // LB-13, LB-14: VAB inside and past the 120-day cap -------------------------
  {
    const vab = absenceDays('vab', ['2026-10-06', '2026-10-07'])
    const deduction = roundOre(2 * D36)
    list.push({
      id: 'LB-13',
      title: 'VAB two days within the 120-day cap: deducted, semesterlönegrundande',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: vab, vabDaysYtd: 10 } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - deduction), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { vab: -deduction },
      },
      formula: 'Avdrag = 2 × dagslön. VAB within 120 days per intjänandeår is semesterlönegrundande: the procentregeln base keeps the full månadslön.',
      sources: [SRC.seml17a1, SRC.seml16b2, SRC.seml16b3, SRC.convDailyDivisor],
    })
    const pastCap = roundOre(1 * D36)
    list.push({
      id: 'LB-14',
      title: 'VAB days 120 and 121: the day past the cap lowers the procentregeln base',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: vab, vabDaysYtd: 119 } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - deduction), vacationAccrual: roundOre((36000 - pastCap) * Y2026.procentregeln) }),
        absenceRows: { vab: -deduction },
      },
      formula: 'Day 120 is semesterlönegrundande, day 121 is not: semesterunderlag = månadslön − 1 dagslön, accrual 12 % of that.',
      sources: [SRC.seml17a1, SRC.seml16b, SRC.seml16b2],
    })
  }

  // LB-15, LB-16: parental leave two weeks ------------------------------------
  {
    const dates = weekdaysBetween('2026-10-05', '2026-10-16')
    const parental = absenceDays('parental', dates)
    const workdayDeduction = roundOre(dates.length * D36)
    list.push({
      id: 'LB-15',
      title: 'Föräldraledighet 5-16 October, long_leave = workdays',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, absence: { periodDays: parental } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - workdayDeduction), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { parental_leave: -workdayDeduction },
      },
      formula: `Avdrag = ${dates.length} weekdays × dagslön. Within 120 days per child it is semesterlönegrundande, so the base keeps the full månadslön.`,
      sources: [SRC.seml17a3, SRC.seml16b3, SRC.convDailyDivisor],
    })
    const calendar = calendarDays(dates[0], dates[dates.length - 1])
    const calendarDeduction = roundOre(kalenderdagslon(36000) * calendar)
    list.push({
      id: 'LB-16',
      title: 'Föräldraledighet 5-16 October, long_leave = calendar_after_five_workdays',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: BERTIL, period: OCT, policy: { long_leave: 'calendar_after_five_workdays' }, absence: { periodDays: parental } },
      expected: {
        ...totals({ employee: BERTIL, paymentDate: OCT.paymentDate, gross: roundOre(36000 - calendarDeduction), vacationAccrual: roundOre(36000 * Y2026.procentregeln) }),
        absenceRows: { parental_leave: -calendarDeduction },
      },
      formula: `More than five working days: avdrag per calendar day, weekend included, ${calendar} × (månadslön × 12 / 365).`,
      sources: [SRC.convLongLeaveCalendar, SRC.seml17a3],
    })
  }

  // LB-17, LB-18: vacation taken under sammalöneregeln ------------------------
  for (const [id, rate] of [
    ['LB-17', 0.0043],
    ['LB-18', 0.008],
  ] as const) {
    const employee: EmployeeSpec = { ...ANNA, vacationRule: 'sammaloneregeln', semestertillaggRate: rate }
    const perDay = roundOre(40000 * rate)
    const tillagg = roundOre(5 * perDay)
    list.push({
      id,
      title: `Five vacation days under sammalöneregeln, semestertillägg ${rate * 100} %`,
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT, vacation: { days: { paid: 5 } } },
      expected: {
        ...totals({
          employee,
          paymentDate: OCT.paymentDate,
          gross: roundOre(40000 + tillagg),
          vacationAccrual: roundOre(40000 * rate * (25 / 12)),
        }),
        vacationRows: { semestertillagg: tillagg },
      },
      formula:
        `The månadslön runs on; semestertillägg = 5 betalda dagar × ${rate * 100} % × månadslön. ` +
        `The month\'s accrual is the earned share of the tillägg: månadslön × ${rate * 100} % × 25 / 12.`,
      sources: [SRC.seml16a1, SRC.seml16a, SRC.vacSammalon, SRC.convSammaloneAccrual],
    })
  }

  // LB-19, LB-20: vacation taken under procentregeln --------------------------
  for (const [id, rate] of [
    ['LB-19', null],
    ['LB-20', 0.13],
  ] as const) {
    const effective = rate ?? Y2026.procentregeln
    const employee: EmployeeSpec = { ...ANNA, vacationPayRate: rate }
    const base = 12 * 40000
    const perDay = roundOre((effective * base) / 25)
    const semesterlon = roundOre(perDay * 5)
    const avdrag = roundOre(dagslon(40000) * 5)
    list.push({
      id,
      title: `Five vacation days under procentregeln at ${effective * 100} %`,
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: {
        employee,
        period: OCT,
        vacation: { days: { paid: 5 }, basis: 'calendar', basisPayslips: earningYear2025(Array(12).fill(40000)) },
      },
      expected: {
        ...totals({
          employee,
          paymentDate: OCT.paymentDate,
          gross: roundOre(40000 - avdrag + semesterlon),
          vacationAccrual: roundOre((40000 - avdrag) * effective),
        }),
        vacationRows: { semesterloneavdrag: -avdrag, semesterlon },
      },
      formula:
        `Semesterlön per day = ${effective * 100} % × earning-year pay (12 × 40 000) / 25 earned days; 5 days paid. ` +
        'The salary for the 5 days is deducted (5 × dagslön). Semesterlön is not semesterlönegrundande, so the month\'s accrual is on the worked pay only.',
      sources: [SRC.seml16b, SRC.seml16b2, SRC.seml7, SRC.vacProcent, SRC.convVacationDeduction],
    })
  }

  // LB-21: the Fortnox procentregeln anchor ----------------------------------
  {
    const bases = [...Array(10).fill(8000), 10000, 10000]
    const sum = bases.reduce((s, b) => s + b, 0)
    list.push({
      id: 'LB-21',
      title: 'Procentregeln day value: 100 000 kr earned at 12 % over 25 days is 480 kr (Fortnox example)',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'procentregeln-day-value',
      inputs: { paymentDate: '2026-06-25', vacationDaysPerYear: 25, vacationPayRate: null, employmentStart: '2019-03-01', payslips: earningYear2025(bases) },
      expected: { perDay: roundOre((sum * Y2026.procentregeln) / 25) },
      formula: 'Day value = 12 % × semesterlönegrundande pay of the earning year / paid days earned.',
      sources: [SRC.seml16b, SRC.seml7, SRC.fortnoxProcent],
      anchors: [{ label: 'Fortnox: (100 000 × 12 %) / 25 = 480 kr per day', computed: roundOre((sum * Y2026.procentregeln) / 25), published: 480, tolerance: 0 }],
    })
  }

  // LB-35 sits here in reading order: the same anchor at a 30-day entitlement.
  {
    const bases = [...Array(10).fill(8000), 10000, 10000]
    const sum = bases.reduce((s, b) => s + b, 0)
    const rate30 = Y2026.procentregeln + 5 * 0.0048
    list.push({
      id: 'LB-35',
      title: 'Procentregeln at 30 days: 14,4 % over 30 days gives the same 480 kr day (Fortnox example)',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'procentregeln-day-value',
      inputs: { paymentDate: '2026-06-25', vacationDaysPerYear: 30, vacationPayRate: null, employmentStart: '2019-03-01', payslips: earningYear2025(bases) },
      expected: { perDay: roundOre((sum * rate30) / 30) },
      formula: 'Beyond 25 days the rate rises 0,48 percentage points per extra day: 30 days = 12 % + 5 × 0,48 % = 14,4 %; day value = 14,4 % × pay / 30.',
      sources: [SRC.seml16b, at(SRC.vacProcent, { at: '11', quote: 'For entitlements beyond 25 days, add 0.48 percentage points per extra day (e.g., 30 days = 14.4%).' }), SRC.fortnoxProcent],
      anchors: [{ label: 'Fortnox: (100 000 × 14,4 %) / 30 = 480 kr per day', computed: roundOre((sum * rate30) / 30), published: 480, tolerance: 0 }],
    })
  }

  // LB-22: termination with semesterersättning and engångsskatt --------------
  {
    const end = '2026-10-15'
    const employee: EmployeeSpec = { ...ANNA, employmentEnd: end }
    const base = roundOre((40000 * weekdaysBetween(OCT.start, end).length) / weekdaysBetween(OCT.start, OCT.end).length)
    const dayValue = roundOre((Y2026.procentregeln * 12 * 40000) / 25)
    const ersattning = roundOre(6 * dayValue)
    list.push({
      id: 'LB-22',
      title: 'Termination 15 October: six untaken days paid as semesterersättning with engångsskatt 33 %',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: {
        employee,
        period: OCT,
        // Flagged semestergrundande on purpose, as an operator might: the law keeps it out regardless.
        lines: [wageLine('semesterersattning', ersattning, 33)],
      },
      expected: totals({
        employee,
        paymentDate: OCT.paymentDate,
        gross: roundOre(base + ersattning),
        oneOff: { amount: ersattning, percent: 33 },
        vacationAccrual: roundOre(base * Y2026.procentregeln),
      }),
      formula:
        'Grundlön prorated to 15 October (workdays). Semesterersättning = 6 days × (12 % × 12 × 40 000 / 25), taxed as engångsbelopp ' +
        'at 33 % with öre dropped; the rest by the table. Semesterersättning is semesterlön, so it is not in the semesterunderlag.',
      sources: [SRC.seml28, SRC.seml29, SRC.seml16b2, SRC.vacSaved, SRC.sfl11, SRC.sff22, SRC.convPartialWorkdays],
    })
  }

  // LB-23, LB-24: part time --------------------------------------------------
  {
    const employee: EmployeeSpec = { ...ANNA, employmentDegree: 80, hoursPerWeek: 32 }
    const base = roundOre(40000 * 0.8)
    list.push({
      id: 'LB-23',
      title: 'Part time 80 %: grundlön, avgifter and accrual on the degree-adjusted pay',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT },
      expected: totals({ employee, paymentDate: OCT.paymentDate, gross: base, vacationAccrual: roundOre(base * Y2026.procentregeln) }),
      formula: 'Grundlön = full-time månadslön × 80 %; avgifter 31,42 % and accrual 12 % of that.',
      sources: [SRC.avgifterTotal, SRC.seml16b],
    })
    const fourDays: EmployeeSpec = { ...employee, workdaysPerWeek: 4, vacationRule: 'sammaloneregeln' }
    const daysOffPerYear = Math.ceil((25 * 4) / 5)
    const paidDays = 5 * (25 / daysOffPerYear)
    const tillagg = roundOre(paidDays * roundOre(base * Y2026.sammaloneTillagg))
    list.push({
      id: 'LB-24',
      title: 'Four-day week: five days off use 6,25 paid days of semestertillägg',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: fourDays, period: OCT, vacation: { days: { paid: 5 } } },
      expected: {
        ...totals({ employee: fourDays, paymentDate: OCT.paymentDate, gross: roundOre(base + tillagg), vacationAccrual: roundOre(base * Y2026.sammaloneTillagg * (25 / 12)) }),
        vacationRows: { semestertillagg: tillagg },
      },
      formula:
        `25 paid days are ${daysOffPerYear} days off at four days a week (25 × 4 / 5, rounded up); each day off uses 25 / ${daysOffPerYear} paid days. ` +
        'Semestertillägg = paid days × 0,43 % × månadslön at 80 %.',
      sources: [SRC.vacShortWeek, SRC.seml12a, SRC.seml16a],
    })
  }

  // LB-25: hourly employee with sick days ------------------------------------
  {
    const employee: EmployeeSpec = {
      ...ANNA,
      salaryType: 'hourly',
      monthlySalary: 0,
      hourlyRate: 185,
      hoursWorked: 152,
      personnummer: '199002140000',
    }
    const base = roundOre(185 * 152)
    const sjuklon = roundOre(185 * Y2026.sjuklonRate * 16)
    const karens = karensavdragHourly(185, 40)
    const vacationBasis = roundOre(base + 185 * 16)
    list.push({
      id: 'LB-25',
      title: 'Hourly employee: 152 h worked, two 8 h sick days, procentregeln',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee, period: OCT, absence: { periodDays: [sickDay('2026-10-06'), sickDay('2026-10-07')] } },
      expected: {
        ...totals({ employee, paymentDate: OCT.paymentDate, gross: roundOre(base + sjuklon - karens), vacationAccrual: roundOre(vacationBasis * Y2026.procentregeln) }),
        absenceRows: { sick_day2_14: sjuklon, sick_karens: -karens },
      },
      formula:
        'Timlön × worked hours, plus sjuklön 80 % × timlön × 16 lost hours, less one karensavdrag = 20 % × 80 % × timlön × 40 h. ' +
        'The procentregeln base gets timlön × the 16 sick hours instead of the sjuklön (16 b § tredje stycket).',
      sources: [SRC.sickDay2to14, SRC.sickKarens, SRC.seml16b2, SRC.seml16b3, SRC.seml17],
    })
  }

  // LB-26 to LB-29: avgifter age tiers ----------------------------------------
  {
    const reduced: EmployeeSpec = { ...ANNA, monthlySalary: 30000, personnummer: '195805120000', taxColumn: 3 }
    list.push({
      id: 'LB-26',
      title: 'Born 1958: 67 at the start of 2026, avgifter 10,21 % (ålderspensionsavgift only)',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: reduced, period: OCT },
      expected: totals({ employee: reduced, paymentDate: OCT.paymentDate, gross: 30000, vacationAccrual: roundOre(30000 * Y2026.procentregeln) }),
      formula: 'Avgifter = 10,21 % of the gross, and 10,21 % on the vacation accrual. Tax table 33 column 3 (worker past the pension age).',
      sources: [SRC.avgifterReduced, SRC.vacAccrual, SRC.taxColumns],
    })
    const standard: EmployeeSpec = { ...ANNA, monthlySalary: 30000, personnummer: '195912310000' }
    list.push({
      id: 'LB-27',
      title: 'Born 31 December 1959: 66 at the start of 2026, full avgifter 31,42 %',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: standard, period: OCT },
      expected: totals({ employee: standard, paymentDate: OCT.paymentDate, gross: 30000, vacationAccrual: roundOre(30000 * Y2026.procentregeln) }),
      formula: 'The reduced rate needs 67 at årets ingång (born 1958 or earlier for 2026); born 1959 pays 31,42 %.',
      sources: [SRC.avgifterReduced, SRC.avgifterTotal],
    })
    const youth: EmployeeSpec = { ...ANNA, monthlySalary: 30000, personnummer: '200502010000' }
    list.push({
      id: 'LB-28',
      title: 'Born 2005, paid October 2026: 20,81 % up to 25 000 kr, 31,42 % above',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: youth, period: OCT },
      expected: totals({ employee: youth, paymentDate: OCT.paymentDate, gross: 30000, vacationAccrual: roundOre(30000 * Y2026.procentregeln), skipAccrualAvgifter: true }),
      formula: 'Avgifter = 25 000 × 20,81 % + (30 000 − 25 000) × 31,42 %.',
      sources: [SRC.avgifterYouth],
    })
    const march = { start: '2026-03-01', end: '2026-03-31', paymentDate: '2026-03-25' }
    list.push({
      id: 'LB-29',
      title: 'Born 2005, paid March 2026: the youth rate starts in April, so 31,42 %',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: youth, period: march },
      expected: totals({ employee: youth, paymentDate: march.paymentDate, gross: 30000, vacationAccrual: roundOre(30000 * Y2026.procentregeln) }),
      formula: 'The temporary reduction runs 1 April 2026 to 30 September 2027; a March payment pays the full 31,42 %.',
      sources: [SRC.avgifterYouth],
    })
  }

  // LB-30, LB-31: engångsskatt rounding ---------------------------------------
  for (const [id, rounding] of [
    ['LB-30', 'truncate'],
    ['LB-31', 'nearest'],
  ] as const) {
    const bonus = 12345.67
    list.push({
      id,
      title: `Bonus 12 345,67 kr with engångsskatt 34 %, one_off_tax_rounding = ${rounding}`,
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: ANNA, period: OCT, policy: { one_off_tax_rounding: rounding }, lines: [wageLine('bonus', bonus, 34)] },
      expected: totals({
        employee: ANNA,
        paymentDate: OCT.paymentDate,
        gross: roundOre(40000 + bonus),
        oneOff: { amount: bonus, percent: 34, rounding },
        vacationAccrual: roundOre((40000 + bonus) * Y2026.procentregeln),
      }),
      formula:
        `Table tax on the månadslön only; engångsskatt = bonus × 34 % ${rounding === 'truncate' ? 'with öre dropped (statutory)' : 'to the nearest krona (compatibility convention)'}. ` +
        'The bonus is förfallen lön, so it is in the procentregeln base.',
      sources: [SRC.sfl11, SRC.sff22, SRC.convOneOffRounding, SRC.seml16b],
    })
  }

  // LB-32, LB-33: kostförmån -------------------------------------------------
  {
    const value = roundOre(15 * Y2026.kostformanLunch)
    list.push({
      id: 'LB-32',
      title: 'Kostförmån: 15 free lunches at the 2026 schablon',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: { employee: ANNA, period: OCT, lines: [benefitLine('benefit_meals', value)] },
      expected: totals({ employee: ANNA, paymentDate: OCT.paymentDate, gross: 40000, benefits: value, vacationAccrual: roundOre(40000 * Y2026.procentregeln) }),
      formula: 'Förmånsvärde = 15 × 124 kr. It enters the tax base and the avgiftsunderlag but is not paid out and not in the semesterunderlag.',
      sources: [SRC.kostforman2026, SRC.processingOrder],
    })
    list.push({
      id: 'LB-33',
      title: 'Kostförmån fully paid by the employee through nettolöneavdrag: no taxable benefit',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'payslip',
      inputs: {
        employee: ANNA,
        period: OCT,
        lines: [benefitLine('benefit_meals', value), netDeductionLine('net_deduction_benefit_payment', -value)],
      },
      expected: totals({ employee: ANNA, paymentDate: OCT.paymentDate, gross: 40000, benefits: 0, netDeductions: value, vacationAccrual: roundOre(40000 * Y2026.procentregeln) }),
      formula: 'The employee pays at least the schablonvärde: the taxable förmånsvärde is 0; the payment still leaves the net pay.',
      sources: [SRC.kostforman2026, SRC.processingOrder],
    })
  }

  // LB-34: declared avgifter --------------------------------------------------
  {
    const rows: DeclaredAvgifterRow[] = Array.from({ length: 4 }, () => ({ basis: 30000.99, rate: 0.3142, category: 'standard' }))
    const underlag = rows.reduce((s, r) => s + Math.trunc(r.basis), 0)
    list.push({
      id: 'LB-34',
      title: 'Declared avgifter: whole-krona underlag per employee, avgift per sats with öre dropped',
      area: 'law-baseline',
      status: 'runnable',
      kind: 'declared-avgifter',
      inputs: { rows },
      expected: { totalUnderlag: underlag, totalAmount: Math.trunc((underlag * 3142) / 10000) },
      formula: 'Underlag per individuppgift in whole kronor (öre dropped), summed per sats; avgift = sum × 31,42 %, öre dropped.',
      sources: [SRC.sff22, SRC.agiTruncation],
    })
  }

  return list
}

export const LAW_SCENARIOS: LawScenario[] = lawScenarios()
