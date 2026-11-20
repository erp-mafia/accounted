/**
 * Amount forms, validity and overlap of the shift-premium engine, pinned to
 * the kollektivavtal texts they were built from. Every figure below was read
 * from the agreement text extracts the feature was specified against (file
 * and line in each test's comment):
 *
 *   almega_service.txt  Almega Tjänsteföretag, tjänstemän (Unionen)
 *   teknik_tjm.txt      Teknikavtalet, tjänstemän
 *   handels_da.txt      Detaljhandelsavtalet (Handels)
 *   grona.txt           Gröna riksavtalet / Visita-HRF
 *   bygg.txt            Byggavtalet
 */
import { describe, it, expect } from 'vitest'
import { computePremiumLines, premiumPayBasis, priceRule, ruleValidOn } from '../shift-premium-engine'
import type { ShiftPremiumRule } from '@/types'

function rule(overrides: Partial<ShiftPremiumRule> & Pick<ShiftPremiumRule, 'id'>): ShiftPremiumRule {
  return {
    company_id: 'co-1',
    name: '',
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    day_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: '00:00',
    end_time: '00:00',
    amount_form: 'percent_of_hourly',
    premium_percent: null,
    monthly_divisor: null,
    sek_per_hour: null,
    hourly_divisor: null,
    valid_from: '2025-01-01',
    valid_to: null,
    item_type: 'ob_weekday_evening',
    priority: 0,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: null,
    ...overrides,
  }
}

const monthly = (fullTime: number, degree = 100) =>
  premiumPayBasis({ salary_type: 'monthly', hourly_rate: null, monthly_salary: fullTime, employment_degree: degree })

function run(args: {
  pay: ReturnType<typeof monthly>
  rules: ShiftPremiumRule[]
  days: Array<{ work_date: string; start_time: string; end_time: string; hours?: number }>
  employeeId?: string
}) {
  return computePremiumLines({
    employeeId: args.employeeId ?? 'emp-1',
    baseHourlyRate: args.pay.hourlyRate,
    monthlySalary: args.pay.monthlySalary,
    workedDays: args.days.map((d) => ({ hours: 8, ...d })),
    rules: args.rules,
  })
}

describe('monthly_divisor: Almega Tjänsteföretag', () => {
  // almega_service.txt:504-505: kvälls- och nattetid kl 18-06, månadslönen / 480.
  const evening = rule({
    id: 'almega-kvall',
    name: 'OB kväll',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '18:00',
    end_time: '06:00',
    amount_form: 'monthly_divisor',
    monthly_divisor: 480,
    item_type: 'ob_weekday_evening',
  })

  it('pays månadslönen / 480 per hour: 3 h on 40 000 kr is 250 kr', () => {
    const lines = run({
      pay: monthly(40000),
      rules: [evening],
      // 2026-05-25 is a Monday.
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '21:00' }],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].hours).toBe(3)
    expect(lines[0].amount).toBe(250)
    expect(lines[0].basis).toMatchObject({
      amount_form: 'monthly_divisor',
      monthly_divisor: 480,
      base: { kind: 'monthly_salary', amount: 40000 },
      rate_per_hour: 83.33,
    })
  })

  it('wraps past midnight: 22:00-04:00 is 6 h at / 480', () => {
    const lines = run({
      pay: monthly(40000),
      rules: [evening],
      days: [{ work_date: '2026-05-25', start_time: '22:00', end_time: '04:00' }],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].hours).toBe(6)
    // 40 000 x 6 / 480 = 500
    expect(lines[0].amount).toBe(500)
  })

  it('weekend / 300 and storhelg / 150 on a holiday', () => {
    // almega_service.txt:507-511 (sön- och helgdagstid, / 300) and 513-520 (storhelg, / 150).
    const weekend = rule({
      id: 'almega-helg',
      day_of_week: [6, 7],
      start_time: '06:00',
      end_time: '00:00',
      amount_form: 'monthly_divisor',
      monthly_divisor: 300,
      item_type: 'ob_weekend',
    })
    const storhelg = rule({
      id: 'almega-storhelg',
      amount_form: 'monthly_divisor',
      monthly_divisor: 150,
      item_type: 'ob_holiday',
      priority: 10,
    })
    // 2026-05-23 is a plain Saturday; 2026-12-25 (juldagen) a Friday.
    const lines = run({
      pay: monthly(40000),
      rules: [weekend, storhelg],
      days: [
        { work_date: '2026-05-23', start_time: '10:00', end_time: '14:00' },
        { work_date: '2026-12-25', start_time: '08:00', end_time: '16:00' },
      ],
    })
    expect(lines.map((l) => [l.workDate, l.sourceRuleId, l.hours, l.amount])).toEqual([
      // 40 000 x 4 / 300 = 533.333...
      ['2026-05-23', 'almega-helg', 4, 533.33],
      // 40 000 x 8 / 150 = 2 133.333...
      ['2026-12-25', 'almega-storhelg', 8, 2133.33],
    ])
  })

  it('övertid / 94 uses the full-time salary of a part-timer, OB / 480 the actual one', () => {
    // almega_service.txt:394-405 (övertid / 94 kl 06-20 helgfria mån-fre, / 72 annan tid)
    // and :408-409 (the part-timer's månadslön is raised to full time for those divisors).
    const overtime = rule({
      id: 'almega-overtid-94',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '17:00',
      end_time: '20:00',
      amount_form: 'monthly_divisor',
      monthly_divisor: 94,
      item_type: 'overtime_50',
      priority: 10,
    })
    const lines = run({
      pay: monthly(40000, 50),
      rules: [overtime, evening],
      days: [{ work_date: '2026-05-25', start_time: '17:00', end_time: '21:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.hours, l.amount])).toEqual([
      // OB 20:00-21:00 on the actual 20 000 kr: 20 000 x 1 / 480 = 41.666...
      ['almega-kvall', 1, 41.67],
      // Övertid 17:00-20:00 on the full-time 40 000 kr: 40 000 x 3 / 94 = 1 276.595...
      ['almega-overtid-94', 3, 1276.6],
    ])
    expect(lines[1].basis.base).toEqual({ kind: 'full_time_monthly_salary', amount: 40000 })
  })

  it('does not apply to an hourly-paid employee: a lower rule wins their minutes', () => {
    const fallback = rule({
      id: 'percent-fallback',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '22:00',
      premium_percent: 50,
      priority: -1,
    })
    const hourly = premiumPayBasis({ salary_type: 'hourly', hourly_rate: 200, monthly_salary: null, employment_degree: 100 })
    const lines = run({
      pay: hourly,
      rules: [evening, fallback],
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '20:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.amount])).toEqual([['percent-fallback', 200]])
    expect(priceRule(evening, hourly)).toBeNull()
  })
})

describe('monthly_divisor: Teknikavtalet tjänstemän', () => {
  // teknik_tjm.txt:2686-2692: förskjuten arbetstid kl 18-24 / 600, kl 00-07 / 400.
  const lateEvening = rule({
    id: 'teknik-18-24',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '18:00',
    end_time: '00:00',
    amount_form: 'monthly_divisor',
    monthly_divisor: 600,
    item_type: 'ob_weekday_evening',
  })
  const night = rule({
    id: 'teknik-00-07',
    day_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: '00:00',
    end_time: '07:00',
    amount_form: 'monthly_divisor',
    monthly_divisor: 400,
    item_type: 'ob_night',
  })

  it('splits a shift over midnight between / 600 and / 400', () => {
    const lines = run({
      pay: monthly(30000),
      rules: [lateEvening, night],
      // Monday 20:00 to Tuesday 03:00.
      days: [{ work_date: '2026-05-25', start_time: '20:00', end_time: '03:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.workDate, l.hours, l.amount])).toEqual([
      // 30 000 x 3 / 400 = 225, still on the Monday's line
      ['teknik-00-07', '2026-05-25', 3, 225],
      // 30 000 x 4 / 600 = 200
      ['teknik-18-24', '2026-05-25', 4, 200],
    ])
  })

  it('never pays OB and övertid for the same hour', () => {
    // teknik_tjm.txt:2717-2718: förskjuten arbetstid and övertid cannot both be paid;
    // övertid / 72 (teknik_tjm.txt:1300-1301) is the higher-priority rule.
    const overtime = rule({
      id: 'teknik-overtid-72',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '20:00',
      end_time: '00:00',
      amount_form: 'monthly_divisor',
      monthly_divisor: 72,
      item_type: 'overtime_100',
      priority: 10,
    })
    const lines = run({
      pay: monthly(30000),
      rules: [lateEvening, overtime],
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '22:00' }],
    })
    const hours = lines.reduce((sum, l) => sum + l.hours, 0)
    expect(hours).toBe(4)
    expect(lines.map((l) => [l.sourceRuleId, l.hours, l.amount])).toEqual([
      ['teknik-18-24', 2, 100],
      // 30 000 x 2 / 72 = 833.333...
      ['teknik-overtid-72', 2, 833.33],
    ])
  })
})

describe('percent_of_hourly with the agreement divisor: Handels', () => {
  // handels_da.txt:1395-1401: 50 % kl 18.15-20.00, 70 % after 20.00 (mån-fre);
  // handels_da.txt:1404-1405: on the timlön 1/166 of the månadslön.
  const ob50 = rule({
    id: 'handels-50',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '18:15',
    end_time: '20:00',
    premium_percent: 50,
    hourly_divisor: 166,
  })
  const ob70 = rule({
    id: 'handels-70',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '20:00',
    end_time: '00:00',
    premium_percent: 70,
    hourly_divisor: 166,
  })

  it('prices a monthly-paid hour as månadslön / 166', () => {
    // 33 200 / 166 = 200 kr timlön.
    const lines = run({
      pay: monthly(33200),
      rules: [ob50, ob70],
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '21:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.hours, l.amount])).toEqual([
      // 18:15-20:00 = 1.75 h x 200 x 50 % = 175
      ['handels-50', 1.75, 175],
      // 20:00-21:00 = 1 h x 200 x 70 % = 140
      ['handels-70', 1, 140],
    ])
  })

  it('a part-timer is priced on the full-time salary / 166 (13.2 B 5)', () => {
    // handels_da.txt:1168-1169: timlön = 38,25 x månadslön / (166 x timmar per vecka),
    // which for a part-timer on full-time 33 200 is still 200 kr.
    const lines = run({
      pay: monthly(33200, 50),
      rules: [ob50],
      days: [{ work_date: '2026-05-25', start_time: '18:15', end_time: '20:00' }],
    })
    expect(lines[0].amount).toBe(175)
  })

  it('an hourly-paid employee keeps their own timlön', () => {
    const hourly = premiumPayBasis({ salary_type: 'hourly', hourly_rate: 180, monthly_salary: null, employment_degree: 100 })
    const lines = run({
      pay: hourly,
      rules: [ob50],
      days: [{ work_date: '2026-05-25', start_time: '18:15', end_time: '20:00' }],
    })
    // 1.75 h x 180 x 50 % = 157.5
    expect(lines[0].amount).toBe(157.5)
    expect(lines[0].basis.base).toEqual({ kind: 'hourly_rate', amount: 180 })
  })

  it('only the highest percentage applies when OB and övertid meet (equal priority)', () => {
    // handels_da.txt:1409-1411 and 1471-1473: only the procentuellt sett högsta ersättningen.
    const sundayOb = rule({
      id: 'handels-sondag-100',
      day_of_week: [7],
      premium_percent: 100,
      hourly_divisor: 166,
      item_type: 'ob_weekend',
    })
    const overtime70 = rule({
      id: 'handels-overtid-70',
      day_of_week: [6, 7],
      premium_percent: 70,
      hourly_divisor: 166,
      item_type: 'overtime_50',
    })
    // 2026-05-24 is a Sunday.
    const sunday = run({
      pay: monthly(33200),
      rules: [overtime70, sundayOb],
      days: [{ work_date: '2026-05-24', start_time: '10:00', end_time: '12:00' }],
    })
    expect(sunday.map((l) => [l.sourceRuleId, l.amount])).toEqual([['handels-sondag-100', 400]])

    // Same priority across forms: the rate per hour decides, not the percent.
    const fixed = rule({ id: 'fixed-45', day_of_week: [7], amount_form: 'sek_per_hour', sek_per_hour: 450, item_type: 'ob_weekend' })
    const mixed = run({
      pay: monthly(33200),
      rules: [sundayOb, fixed],
      days: [{ work_date: '2026-05-24', start_time: '10:00', end_time: '12:00' }],
    })
    // 450 kr per hour beats 100 % of 200 kr.
    expect(mixed.map((l) => [l.sourceRuleId, l.amount])).toEqual([['fixed-45', 900]])
  })

  it('pays the övertid step of 2026-04-01 per day inside one pay period', () => {
    // handels_da.txt:1476-1482 (50 % to 2026-03-31) and 1496-1510 (35 % from 2026-04-01).
    const before = rule({
      id: 'handels-overtid-50',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '20:00',
      premium_percent: 50,
      hourly_divisor: 166,
      item_type: 'overtime_50',
      valid_from: '2025-04-01',
      valid_to: '2026-03-31',
    })
    const after = rule({ ...before, id: 'handels-overtid-35', premium_percent: 35, valid_from: '2026-04-01', valid_to: null })
    const lines = run({
      pay: monthly(33200),
      rules: [before, after],
      // Tuesday 2026-03-31 and Wednesday 2026-04-01.
      days: [
        { work_date: '2026-03-31', start_time: '18:00', end_time: '20:00' },
        { work_date: '2026-04-01', start_time: '18:00', end_time: '20:00' },
      ],
    })
    expect(lines.map((l) => [l.workDate, l.sourceRuleId, l.amount])).toEqual([
      ['2026-03-31', 'handels-overtid-50', 200],
      ['2026-04-01', 'handels-overtid-35', 140],
    ])
  })
})

describe('sek_per_hour: Gröna riksavtalet', () => {
  // grona.txt:761-770: OB mån-fre kl 20.00-06.00, 26:79 kr/timme from 2025-04-01, 27:59 from 2026-04-01.
  const ob2025 = rule({
    id: 'grona-ob-2025',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '20:00',
    end_time: '06:00',
    amount_form: 'sek_per_hour',
    sek_per_hour: 26.79,
    valid_from: '2025-04-01',
    valid_to: '2026-03-31',
  })
  const ob2026 = rule({ ...ob2025, id: 'grona-ob-2026', sek_per_hour: 27.59, valid_from: '2026-04-01', valid_to: null })

  it('pays the rate valid on each worked date, also across midnight', () => {
    const lines = run({
      pay: premiumPayBasis({ salary_type: 'hourly', hourly_rate: 165, monthly_salary: null, employment_degree: 100 }),
      rules: [ob2025, ob2026],
      days: [
        // Monday 2026-03-30: 3 h x 26.79 = 80.37
        { work_date: '2026-03-30', start_time: '20:00', end_time: '23:00' },
        // Tuesday 2026-03-31 22:00 to Wednesday 02:00: 2 h at 26.79 before
        // midnight, 2 h at 27.59 after it (the work is done on 2026-04-01).
        { work_date: '2026-03-31', start_time: '22:00', end_time: '02:00' },
        // Thursday 2026-04-02: 3 h x 27.59 = 82.77
        { work_date: '2026-04-02', start_time: '20:00', end_time: '23:00' },
      ],
    })
    expect(lines.map((l) => [l.workDate, l.sourceRuleId, l.hours, l.amount])).toEqual([
      ['2026-03-30', 'grona-ob-2025', 3, 80.37],
      ['2026-03-31', 'grona-ob-2025', 2, 53.58],
      ['2026-03-31', 'grona-ob-2026', 2, 55.18],
      ['2026-04-02', 'grona-ob-2026', 3, 82.77],
    ])
    expect(lines[3].basis).toMatchObject({ amount_form: 'sek_per_hour', sek_per_hour: 27.59, base: { kind: 'none', amount: null } })
  })

  it('natt-OB paid on top of OB is one combined rule with a higher priority', () => {
    // grona.txt:774-779: natt-OB kl 01.00-06.00 is paid utöver (on top of) punkt 1,
    // 24:31 kr/timme from 2026-04-01. One winner per minute, so the night hours
    // carry the sum: 27.59 + 24.31 = 51.90.
    const nightCombined = rule({
      id: 'grona-natt-2026',
      day_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: '01:00',
      end_time: '06:00',
      amount_form: 'sek_per_hour',
      sek_per_hour: 51.9,
      item_type: 'ob_night',
      valid_from: '2026-04-01',
      priority: 1,
    })
    const lines = run({
      pay: premiumPayBasis({ salary_type: 'hourly', hourly_rate: 165, monthly_salary: null, employment_degree: 100 }),
      rules: [ob2026, nightCombined],
      // Monday 2026-05-25 22:00 to Tuesday 03:00.
      days: [{ work_date: '2026-05-25', start_time: '22:00', end_time: '03:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.hours, l.amount])).toEqual([
      // 01:00-03:00 = 2 h x 51.90 = 103.80
      ['grona-natt-2026', 2, 103.8],
      // 22:00-01:00 = 3 h x 27.59 = 82.77
      ['grona-ob-2026', 3, 82.77],
    ])
  })
})

describe('overlap: Byggavtalet, no OB on overtime hours', () => {
  // bygg.txt:975 (OB-ersättning utges inte vid övertidsarbete), 979-987 (OB 2 = 40 %
  // kl 18-22 mån-fre) and the övertid table after it (övertid B = 50 % kl 17-19).
  const ob2 = rule({ id: 'bygg-ob2', day_of_week: [1, 2, 3, 4, 5], start_time: '18:00', end_time: '22:00', premium_percent: 40 })
  const overtimeB = rule({
    id: 'bygg-overtid-b',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '17:00',
    end_time: '19:00',
    premium_percent: 50,
    item_type: 'overtime_50',
    priority: 10,
  })

  it('gives the overlapping hour to övertid only', () => {
    const lines = run({
      pay: premiumPayBasis({ salary_type: 'hourly', hourly_rate: 250, monthly_salary: null, employment_degree: 100 }),
      rules: [ob2, overtimeB],
      days: [{ work_date: '2026-05-25', start_time: '17:00', end_time: '21:00' }],
    })
    expect(lines.map((l) => [l.sourceRuleId, l.hours, l.amount])).toEqual([
      // OB 2 only on 19:00-21:00: 2 h x 250 x 40 % = 200
      ['bygg-ob2', 2, 200],
      // Övertid B on 17:00-19:00: 2 h x 250 x 50 % = 250
      ['bygg-overtid-b', 2, 250],
    ])
  })
})

describe('validity and determinism', () => {
  it('judges the holiday gate on the date the minutes fall on', () => {
    // Annandag jul 2026 is a Saturday; the Sunday after it is no holiday.
    const holiday = rule({ id: 'helgdag', premium_percent: 100, item_type: 'ob_holiday' })
    const lines = run({
      pay: premiumPayBasis({ salary_type: 'hourly', hourly_rate: 200, monthly_salary: null, employment_degree: 100 }),
      rules: [holiday],
      days: [{ work_date: '2026-12-26', start_time: '22:00', end_time: '04:00' }],
    })
    expect(lines.map((l) => [l.hours, l.amount])).toEqual([[2, 400]])
  })

  it('a rule outside its validity pays nothing', () => {
    const ended = rule({ id: 'ended', premium_percent: 50, valid_from: '2025-01-01', valid_to: '2026-04-30' })
    const notYet = rule({ id: 'not-yet', premium_percent: 50, valid_from: '2026-06-01' })
    const lines = run({
      pay: monthly(30000),
      rules: [ended, notYet],
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '20:00' }],
    })
    expect(lines).toEqual([])
    expect(ruleValidOn({ valid_from: null, valid_to: null }, '1999-01-01')).toBe(true)
    expect(ruleValidOn({ valid_from: '2026-04-01', valid_to: '2026-04-01' }, '2026-04-01')).toBe(true)
  })

  it('breaks a full tie by rule id, whatever order the rules come in', () => {
    const a = rule({ id: 'a-rule', premium_percent: 50, item_type: 'ob_weekend' })
    const b = rule({ id: 'b-rule', premium_percent: 50, item_type: 'ob_night' })
    const args = {
      pay: monthly(30000),
      days: [{ work_date: '2026-05-23', start_time: '10:00', end_time: '12:00' }],
    }
    const ab = run({ ...args, rules: [a, b] })
    const ba = run({ ...args, rules: [b, a] })
    expect(ab).toEqual(ba)
    expect(ab.map((l) => l.sourceRuleId)).toEqual(['a-rule'])
  })

  it('a sek_per_hour rule pays even when the employee has no salary registered', () => {
    const fixed = rule({ id: 'fixed', amount_form: 'sek_per_hour', sek_per_hour: 30 })
    const lines = run({
      pay: monthly(0),
      rules: [fixed],
      days: [{ work_date: '2026-05-25', start_time: '18:00', end_time: '20:00' }],
    })
    expect(lines.map((l) => l.amount)).toEqual([60])
  })
})
