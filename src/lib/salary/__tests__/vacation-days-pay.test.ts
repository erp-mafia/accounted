/**
 * Pay derived from vacation days taken (issue #85, lib/salary/vacation-days-pay.ts).
 *
 * Every expected figure is worked by hand from Semesterlagen (1977:480),
 * read on riksdagen.se 2026-10-23 (docs/research/payroll-semester-derived-pay.md):
 *   - 16 a §: semestertillägg "för varje betald semesterdag ... 0,43 procent
 *     av månadslönen"; the monthly salary runs on.
 *   - 16 b §: semesterlön = 12 % of the pay of the intjänandeår, per paid day
 *     that total / the paid days earned (7 §); the salary for the days goes.
 *   - 22 §: sparade dagar count as earned in the most recent intjänandeår.
 *   - 8 §: days without semesterlön; the deduction is the engine's dagslön.
 *   - 12 a §: on a short week one day off uses more than one paid day.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveVacationDaysPay,
  isDaysOnlyVacationLine,
  paidLikeDaysOff,
  procentregelnBasisFromBreakdown,
  procentregelnDayValue,
  vacationDaysOff,
  type DeriveVacationDaysPayInput,
  type ProcentregelnBasisPayslip,
  type ProcentregelnDayValue,
  type VacationDaysOff,
} from '../vacation-days-pay'

const NO_DAYS: VacationDaysOff = { paid: 0, extraPaid: 0, saved: 0, unpaid: 0, advance: 0 }

function input(
  overrides: Partial<Omit<DeriveVacationDaysPayInput, 'days'>> & { days: Partial<VacationDaysOff> },
): DeriveVacationDaysPayInput {
  return {
    vacationRule: 'sammaloneregeln',
    salaryType: 'monthly',
    monthlySalary: 40000,
    semestertillaggRate: 0.0043,
    dailyDivisor: 21,
    paidDaysPerDayOff: 1,
    ...overrides,
    days: { ...NO_DAYS, ...overrides.days },
  }
}

/** A known day value: 12 % of 480 000 kr over 25 earned days = 2 304 kr. */
const KNOWN_2304: ProcentregelnDayValue = {
  known: true,
  yearStart: '2025-04-01',
  yearLabel: '2025/2026',
  base: 480000,
  rate: 0.12,
  earnedDays: 25,
  payslips: 12,
  perDay: 2304,
}

describe('which vacation lines are priced', () => {
  it('a hand-entered vacation line with days and no amount; not one with an amount, an engine row or no days', () => {
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: 5, amount: 0 })).toBe(true)
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: 5, amount: null })).toBe(true)
    // The operator priced it (quantity x à-pris): paid as entered.
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: 5, amount: 860 })).toBe(false)
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: 0, amount: 0 })).toBe(false)
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: null, amount: 0 })).toBe(false)
    expect(isDaysOnlyVacationLine({ item_type: 'vacation', quantity: 5, amount: 0, calculation_source: 'vacation_pay' })).toBe(false)
    expect(isDaysOnlyVacationLine({ item_type: 'other', quantity: 5, amount: 0 })).toBe(false)
  })

  it('sums days off per category; NULL is paid', () => {
    const days = vacationDaysOff([
      { item_type: 'vacation', quantity: 3, amount: 0, vacation_category: null },
      { item_type: 'vacation', quantity: 2, amount: 0, vacation_category: 'paid' },
      { item_type: 'vacation', quantity: 1, amount: 0, vacation_category: 'extra_paid' },
      { item_type: 'vacation', quantity: 2, amount: 0, vacation_category: 'saved' },
      { item_type: 'vacation', quantity: 1.5, amount: 0, vacation_category: 'unpaid' },
      { item_type: 'vacation', quantity: 4, amount: 0, vacation_category: 'advance' },
      // Priced by hand: not counted here.
      { item_type: 'vacation', quantity: 9, amount: 1000, vacation_category: 'paid' },
    ])
    expect(days).toEqual({ paid: 5, extraPaid: 1, saved: 2, unpaid: 1.5, advance: 4 })
    expect(paidLikeDaysOff(days)).toBe(8)
  })
})

describe('sammalöneregeln: semestertillägg (16 a §)', () => {
  it('5 paid days at 0,43 % of 40 000 kr: 172,00 kr a day, 860,00 kr; the salary runs on', () => {
    const result = deriveVacationDaysPay(input({ days: { paid: 5 } }))
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.rows).toEqual([
      {
        kind: 'semestertillagg',
        description: 'Semestertillägg 5 dagar × 172,00 kr (0,43 % av 40 000,00 kr)',
        amount: 860,
        is_vacation_basis: false,
        is_gross_deduction: false,
        sort_order: 54,
      },
    ])
    expect(result.steps).toEqual([
      expect.objectContaining({
        label: 'Semestertillägg (Semesterlagen 16 a §, 0,43 %)',
        input: expect.objectContaining({ paid_days: 5, monthly_salary: 40000, semestertillagg_rate: 0.0043, per_day: 172 }),
        output: 860,
      }),
    ])
  })

  it('sparade dagar at a kollektivavtal rate of 0,8 %: 3 days x 320,00 kr = 960,00 kr (22 §)', () => {
    const result = deriveVacationDaysPay(input({ semestertillaggRate: 0.008, days: { saved: 3 } }))
    expect(result.ok && result.rows.map((r) => r.amount)).toEqual([960])
    expect(result.ok && result.steps[0].input).toMatchObject({ saved_days_off: 3, per_day: 320 })
  })

  it('extra betalda days are paid days: 3 paid + 2 extra = 5 x 172,00 = 860,00 kr', () => {
    const result = deriveVacationDaysPay(input({ days: { paid: 3, extraPaid: 2 } }))
    expect(result.ok && result.rows.map((r) => r.amount)).toEqual([860])
  })

  it('part time, four days a week: 60 % of 30 000 = 18 000 kr; 4 days off are 5 paid days (12 a §) x 77,40 kr = 387,00 kr', () => {
    const result = deriveVacationDaysPay(input({ monthlySalary: 18000, paidDaysPerDayOff: 1.25, days: { paid: 4 } }))
    expect(result.ok && result.rows).toEqual([
      expect.objectContaining({
        description: 'Semestertillägg 5 betalda dagar (4 lediga) × 77,40 kr (0,43 % av 18 000,00 kr)',
        amount: 387,
      }),
    ])
  })

  it('förskott derives nothing: the monthly salary is the advance pay; the breakdown says so', () => {
    const result = deriveVacationDaysPay(input({ days: { advance: 2 } }))
    expect(result).toEqual({
      ok: true,
      rows: [],
      steps: [expect.objectContaining({ label: 'Förskottssemester', input: { days_off: 2 }, output: null })],
    })
  })

  it('obetalda dagar: 2 days x 40 000 / 21 = 1 904,76 kr, -3 809,52 kr, lowering the base and the salary account', () => {
    const result = deriveVacationDaysPay(input({ days: { unpaid: 2 } }))
    expect(result.ok && result.rows).toEqual([
      {
        kind: 'obetald_semester',
        description: 'Obetald semester 2 dagar × 1 904,76 kr',
        amount: -3809.52,
        is_vacation_basis: true,
        is_gross_deduction: true,
        sort_order: 55,
      },
    ])
  })

  it('a stored rate of 0 or a 0 kr salary (nollkörning) writes no 0 kr row', () => {
    expect(deriveVacationDaysPay(input({ semestertillaggRate: 0, days: { paid: 5 } }))).toEqual({ ok: true, rows: [], steps: [] })
    expect(deriveVacationDaysPay(input({ monthlySalary: 0, days: { paid: 5 } }))).toEqual({ ok: true, rows: [], steps: [] })
  })

  it('hourly pay on sammalöneregeln is refused: no månadslön to take 0,43 % of (16 § andra stycket 1)', () => {
    const result = deriveVacationDaysPay(input({ salaryType: 'hourly', days: { paid: 3 } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.sv).toContain('16 § andra stycket 1')
    expect(result.reason.en).toContain('procentregeln')
  })

  it('hourly obetalda dagar deduct nothing: unworked hours were never paid', () => {
    expect(deriveVacationDaysPay(input({ salaryType: 'hourly', vacationRule: 'procentregeln', days: { unpaid: 2 } }))).toEqual({
      ok: true,
      rows: [],
      steps: [],
    })
  })
})

describe('procentregeln: semesterlöneavdrag and semesterlön (16 b §)', () => {
  it('5 days with a 2 304 kr day value: avdrag 5 x 1 904,76 = -9 523,80 kr, semesterlön 5 x 2 304 = 11 520 kr', () => {
    const result = deriveVacationDaysPay(input({ vacationRule: 'procentregeln', days: { paid: 5 }, procentregelnDayValue: KNOWN_2304 }))
    expect(result.ok && result.rows).toEqual([
      {
        kind: 'semesterloneavdrag',
        description: 'Semesterlöneavdrag 5 dagar × 1 904,76 kr',
        amount: -9523.8,
        is_vacation_basis: true,
        is_gross_deduction: true,
        sort_order: 52,
      },
      {
        kind: 'semesterlon',
        description: 'Semesterlön 5 dagar × 2 304,00 kr (12 % av 480 000,00 kr / 25 dagar, 2025/2026)',
        amount: 11520,
        // Semesterlön is not semesterlönegrundande (16 b § andra stycket 1).
        is_vacation_basis: false,
        is_gross_deduction: false,
        sort_order: 53,
      },
    ])
    expect(result.ok && result.steps.find((s) => s.label.startsWith('Semesterlön ('))?.input).toMatchObject({
      vacation_basis: 480000,
      earned_days: 25,
      earning_year: '2025/2026',
      payslips: 12,
      per_day: 2304,
    })
  })

  it('sparade dagar use the same day value (22 §): 2 saved days = 2 x 2 304 kr, less 2 dagslöner', () => {
    const result = deriveVacationDaysPay(input({ vacationRule: 'procentregeln', days: { saved: 2 }, procentregelnDayValue: KNOWN_2304 }))
    expect(result.ok && result.rows.map((r) => r.amount)).toEqual([-3809.52, 4608])
  })

  it('four days a week: 4 days off = 5 paid days; avdrag per day off at 40 000 / 17,33 = 2 308,14 kr, semesterlön per paid day', () => {
    const result = deriveVacationDaysPay(
      input({ vacationRule: 'procentregeln', dailyDivisor: 17.33, paidDaysPerDayOff: 1.25, days: { paid: 4 }, procentregelnDayValue: KNOWN_2304 }),
    )
    // dailyDivisor(4) = 4 x 52 / 12 = 17,33; 40 000 / 17,33 = 2 308,14 kr x 4 = 9 232,56 kr; 2 304 x 5 = 11 520 kr.
    expect(result.ok && result.rows.map((r) => r.amount)).toEqual([-9232.56, 11520])
    expect(result.ok && result.rows[1].description).toContain('5 betalda dagar (4 lediga)')
  })

  it('hourly pay: the semesterlön only (timlön is paid for hours worked, nothing to deduct)', () => {
    const value: ProcentregelnDayValue = { ...KNOWN_2304, base: 384000, perDay: 1843.2 }
    const result = deriveVacationDaysPay(input({ vacationRule: 'procentregeln', salaryType: 'hourly', days: { paid: 3 }, procentregelnDayValue: value }))
    // 12 % x 384 000 / 25 = 1 843,20 kr a day; 3 days = 5 529,60 kr.
    expect(result.ok && result.rows.map((r) => [r.kind, r.amount])).toEqual([['semesterlon', 5529.6]])
  })

  it('an unknown base refuses the line with the reason, never a guessed amount', () => {
    const reason = { sv: 'saknas', en: 'missing' }
    const result = deriveVacationDaysPay(
      input({ vacationRule: 'procentregeln', days: { paid: 5 }, procentregelnDayValue: { known: false, reason } }),
    )
    expect(result).toEqual({ ok: false, reason })
  })

  it('förskott for monthly pay derives nothing; for hourly pay it is refused', () => {
    expect(deriveVacationDaysPay(input({ vacationRule: 'procentregeln', days: { advance: 3 } }))).toMatchObject({ ok: true, rows: [] })
    const hourly = deriveVacationDaysPay(input({ vacationRule: 'procentregeln', salaryType: 'hourly', days: { advance: 3 } }))
    expect(hourly.ok).toBe(false)
  })
})

describe('the other vacation rules', () => {
  it('semesterersättning: paid days are refused (the vacation pay was already paid out), obetalda deduct', () => {
    expect(deriveVacationDaysPay(input({ vacationRule: 'semesterersattning', days: { paid: 2 } })).ok).toBe(false)
    expect(deriveVacationDaysPay(input({ vacationRule: 'semesterersattning', days: { advance: 2 } })).ok).toBe(false)
    const unpaid = deriveVacationDaysPay(input({ vacationRule: 'semesterersattning', days: { unpaid: 1 } }))
    expect(unpaid.ok && unpaid.rows.map((r) => r.amount)).toEqual([-1904.76])
  })

  it('none (vacation inside the salary): paid days derive nothing, obetalda deduct', () => {
    expect(deriveVacationDaysPay(input({ vacationRule: 'none', days: { paid: 5, saved: 1, advance: 1 } }))).toEqual({
      ok: true,
      rows: [],
      steps: [],
    })
    const unpaid = deriveVacationDaysPay(input({ vacationRule: 'none', days: { unpaid: 1 } }))
    expect(unpaid.ok && unpaid.rows.map((r) => r.amount)).toEqual([-1904.76])
  })
})

function payslip(paymentDate: string, vacationBasis: number | null = 40000, status = 'booked'): ProcentregelnBasisPayslip {
  return { salaryRunId: `run-${paymentDate}`, paymentDate, status, vacationBasis }
}

/** One payslip on the 25th of every month from `from` (YYYY-MM) for `count` months. */
function monthly(from: string, count: number, vacationBasis = 40000): ProcentregelnBasisPayslip[] {
  const out: ProcentregelnBasisPayslip[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  for (let i = 0; i < count; i++) {
    out.push(payslip(`${year}-${String(month).padStart(2, '0')}-25`, vacationBasis))
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

const STATUTORY = {
  paymentDate: '2026-07-25',
  basis: 'statutory_apr_mar' as const,
  employmentStart: '2019-03-01',
  employmentEnd: null,
  vacationDaysPerYear: 25,
  vacationPayRate: null,
}

describe('procentregelnDayValue: the base year (16 b §, 7 §, 22 §)', () => {
  it('statutory basis: twelve payslips April 2025 to March 2026 at 40 000 kr, 12 % x 480 000 / 25 = 2 304,00 kr', () => {
    expect(procentregelnDayValue({ ...STATUTORY, payslips: monthly('2025-04', 12) })).toEqual({
      known: true,
      yearStart: '2025-04-01',
      yearLabel: '2025/2026',
      base: 480000,
      rate: 0.12,
      earnedDays: 25,
      payslips: 12,
      perDay: 2304,
    })
  })

  it('reads only the base year: payslips before it and in the running year are left out', () => {
    const payslips = [payslip('2025-03-25', 99999), ...monthly('2025-04', 12), payslip('2026-04-25', 99999)]
    expect(procentregelnDayValue({ ...STATUTORY, payslips })).toMatchObject({ known: true, base: 480000, payslips: 12 })
  })

  it('30 days at 14,4 % and a kollektivavtal 13 % at 25 days', () => {
    // 14,4 % x 480 000 / 30 = 2 304,00 kr: the extra 0,48 percentage points per day keep the day value.
    expect(procentregelnDayValue({ ...STATUTORY, vacationDaysPerYear: 30, payslips: monthly('2025-04', 12) })).toMatchObject({
      rate: 0.144,
      earnedDays: 30,
      perDay: 2304,
    })
    // 13 % x 480 000 / 25 = 2 496,00 kr.
    expect(procentregelnDayValue({ ...STATUTORY, vacationPayRate: 0.13, payslips: monthly('2025-04', 12) })).toMatchObject({
      rate: 0.13,
      perDay: 2496,
    })
  })

  it('first year, hired 1 October 2025: 13 days earned (25 x 182 / 365 rounded up, 7 §), 12 % x 240 000 / 13 = 2 215,38 kr', () => {
    const value = procentregelnDayValue({ ...STATUTORY, employmentStart: '2025-10-01', payslips: monthly('2025-10', 6) })
    expect(value).toMatchObject({ known: true, base: 240000, earnedDays: 13, perDay: 2215.38 })
  })

  it('hired after the base year: no paid days earned, refused with what to do', () => {
    const value = procentregelnDayValue({ ...STATUTORY, employmentStart: '2026-05-01', payslips: [] })
    expect(value.known).toBe(false)
    if (value.known) return
    expect(value.reason.sv).toContain('inga betalda semesterdagar är intjänade under intjänandeåret 2025/2026')
    expect(value.reason.sv).toContain('obetalda eller förskott')
  })

  it('history outside Accounted (a cutover): the missing months are named and nothing is guessed', () => {
    const value = procentregelnDayValue({ ...STATUTORY, payslips: monthly('2025-09', 7) })
    expect(value.known).toBe(false)
    if (value.known) return
    expect(value.reason.sv).toContain('saknar godkända lönebesked för 5 månader mellan 2025-04 och 2025-08')
    expect(value.reason.sv).toContain('Ange semesterlönen själv på semesterraden')
    expect(value.reason.en).toContain('no approved, paid or booked payslip for 5 months between 2025-04 and 2025-08')
  })

  it('a few months missing are listed one by one', () => {
    const value = procentregelnDayValue({ ...STATUTORY, payslips: monthly('2025-04', 9) })
    expect(!value.known && value.reason.sv).toContain('för 2026-01, 2026-02, 2026-03.')
  })

  it('a draft or review payslip is not due yet; a corrected one is replaced by its booked correction', () => {
    const payslips = monthly('2025-04', 12)
    payslips[5] = payslip('2025-09-25', 40000, 'review')
    expect(procentregelnDayValue({ ...STATUTORY, payslips }).known).toBe(false)
    payslips[5] = payslip('2025-09-25', 40000, 'corrected')
    payslips.push({ ...payslip('2025-09-28', 38000, 'booked'), salaryRunId: 'run-correction' })
    expect(procentregelnDayValue({ ...STATUTORY, payslips })).toMatchObject({ known: true, base: 478000 })
  })

  it('a month calculated under another rule is refused: its pay never entered a procentregeln base', () => {
    const payslips = monthly('2025-04', 12)
    payslips[0] = payslip('2025-04-25', null)
    const value = procentregelnDayValue({ ...STATUTORY, payslips })
    expect(!value.known && value.reason.sv).toContain('lönebeskeden för 2025-04 beräknades inte enligt procentregeln')
  })

  it('calendar basis: the previous calendar year, employed all of it', () => {
    const value = procentregelnDayValue({ ...STATUTORY, basis: 'calendar', payslips: monthly('2025-01', 12) })
    expect(value).toMatchObject({ known: true, yearStart: '2025-01-01', yearLabel: '2025', base: 480000, earnedDays: 25, perDay: 2304 })
  })

  it('calendar basis, hired during that year: the agreement decides, refused', () => {
    const value = procentregelnDayValue({ ...STATUTORY, basis: 'calendar', employmentStart: '2025-06-01', payslips: monthly('2025-06', 7) })
    expect(!value.known && value.reason.sv).toContain('inte anställd hela året')
  })
})

describe('procentregelnBasisFromBreakdown', () => {
  it('reads the semesterunderlag of the procentregeln accrual step, null under another rule', () => {
    expect(
      procentregelnBasisFromBreakdown({
        steps: [
          { label: 'Grundlön', input: {}, output: 40000 },
          { label: 'Semesteravsättning (procentregeln 12 %)', input: { vacation_basis: 30476.2, rate: 0.12 }, output: 3657.14 },
        ],
      }),
    ).toBe(30476.2)
    expect(
      procentregelnBasisFromBreakdown({
        steps: [{ label: 'Semesteravsättning (sammalöneregeln, tillägg 0,43 %)', input: { monthly_base: 40000 }, output: 358.33 }],
      }),
    ).toBeNull()
    expect(procentregelnBasisFromBreakdown(null)).toBeNull()
  })
})
