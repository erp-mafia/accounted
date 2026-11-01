import { describe, it, expect } from 'vitest'
import {
  deriveAbsenceLineItems,
  backAtWorkBetween,
  buildSjukloneperioder,
  sjukloneperiodDayIndex,
  sjukloneperiodGapTolerance,
  calculateVabDeduction,
  calculateParentalLeaveDeduction,
  AbsenceInputError,
  type AbsenceDay,
  type DeriveInput,
} from '../derive-absence-line-items'
import type { PayrollConfig } from '../payroll-config'
import { roundOre } from '@/lib/money'

const config: PayrollConfig = {
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

const days = (entries: Array<[string, AbsenceDay['absence_type']]>): AbsenceDay[] =>
  entries.map(([d, t]) => ({ absence_date: d, absence_type: t, hours: 8 }))

const baseInput = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  monthlySalary: 30000,
  payrollConfig: config,
  periodDays: [],
  lookbackSickDates: [],
  vabDaysYtd: 0,
  parentalDaysPregnancyYtd: 0,
  ...over,
})

describe('buildSjukloneperioder', () => {
  it('treats consecutive days as one period', () => {
    const segs = buildSjukloneperioder(['2026-04-06', '2026-04-07', '2026-04-08'])
    expect(segs).toHaveLength(1)
    expect(segs[0].sickDayCount).toBe(3)
    expect(segs[0].startDate).toBe('2026-04-06')
    expect(segs[0].endDate).toBe('2026-04-08')
  })

  it('merges segments within 5-day återinsjuknande window', () => {
    // Sick Mon-Wed, gap Thu-Fri-Sat-Sun-Mon (5 days), sick Tue
    // Gap from last sick (Wed Apr 8) to next (Tue Apr 14) = 6 calendar days → new period
    const segs1 = buildSjukloneperioder(['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-14'])
    expect(segs1).toHaveLength(2)

    // Gap of exactly 5 days → same period
    // Wed Apr 8 → Mon Apr 13 = 5 days
    const segs2 = buildSjukloneperioder(['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-13'])
    expect(segs2).toHaveLength(1)
    expect(segs2[0].sickDayCount).toBe(4)
  })

  it('starts a new period when gap is >5 days', () => {
    const segs = buildSjukloneperioder(['2026-04-06', '2026-04-13'])
    // gap = 7 → new period
    expect(segs).toHaveLength(2)
  })

  it('widens the gap to the schedule for sparse schedules (#2876)', () => {
    // One working day a week: consecutive scheduled days are 7 apart.
    expect(sjukloneperiodGapTolerance(1)).toBe(7)
    expect(sjukloneperiodGapTolerance(2)).toBe(6)
    // Three or more days a week never need more than the law's 5.
    expect(sjukloneperiodGapTolerance(3)).toBe(5)
    expect(sjukloneperiodGapTolerance(4)).toBe(5)
    expect(sjukloneperiodGapTolerance(5)).toBe(5)
    expect(sjukloneperiodGapTolerance(7)).toBe(5)
    // Missing or nonsense schedule = the five-day week.
    expect(sjukloneperiodGapTolerance(undefined)).toBe(5)
    expect(sjukloneperiodGapTolerance(null)).toBe(5)
    expect(sjukloneperiodGapTolerance(0)).toBe(5)
    expect(sjukloneperiodGapTolerance(-1)).toBe(5)
    expect(sjukloneperiodGapTolerance(Number.NaN)).toBe(5)

    // Sick on five consecutive Wednesdays, one day a week: one period.
    const weekly = ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']
    expect(buildSjukloneperioder(weekly, 1)).toHaveLength(1)
    expect(buildSjukloneperioder(weekly, 1)[0].sickDayCount).toBe(5)
    // The same dates on a five-day week are five separate periods (unchanged).
    expect(buildSjukloneperioder(weekly, 5)).toHaveLength(5)
    expect(buildSjukloneperioder(weekly)).toHaveLength(5)
    // A 14-day gap on a one-day week means she worked in between: new period.
    expect(buildSjukloneperioder(['2026-09-02', '2026-09-16'], 1)).toHaveLength(2)
    // Two days a week (Tuesday and Wednesday): Wednesday to Tuesday is 6.
    expect(buildSjukloneperioder(['2026-09-02', '2026-09-08', '2026-09-09'], 2)).toHaveLength(1)
    expect(buildSjukloneperioder(['2026-09-02', '2026-09-09'], 2)).toHaveLength(2)
  })

  it('returns empty for empty input', () => {
    expect(buildSjukloneperioder([])).toEqual([])
  })

  it('deduplicates duplicate dates', () => {
    const segs = buildSjukloneperioder(['2026-04-06', '2026-04-06', '2026-04-07'])
    expect(segs).toHaveLength(1)
    expect(segs[0].sickDayCount).toBe(2)
  })
})

describe('deriveAbsenceLineItems: sick', () => {
  it('emits karensavdrag for a single sick day', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ periodDays: days([['2026-04-06', 'sick']]) }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')
    expect(karens).toBeDefined()
    expect(karens!.quantity).toBe(1)
    expect(karens!.amount).toBeLessThan(0)
    // Day one also receives sjuklön (SjLL 6 § since 2019): the 20 % gap on
    // that day is deducted next to the karensavdrag.
    const dayOne = result.lineItems.find(li => li.item_type === 'sick_day2_14')
    expect(dayOne!.quantity).toBe(1)
    expect(dayOne!.amount).toBe(-285.71) // 1428.57 lost, 1142.86 sjuklön
    expect(result.aggregated.sickDays).toBe(1)
  })

  it('emits karens + day-2-14 for a 5-day period', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([
          ['2026-04-06', 'sick'],
          ['2026-04-07', 'sick'],
          ['2026-04-08', 'sick'],
          ['2026-04-09', 'sick'],
          ['2026-04-10', 'sick'],
        ]),
      }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')
    const day2_14 = result.lineItems.find(li => li.item_type === 'sick_day2_14')
    expect(karens).toBeDefined()
    expect(day2_14).toBeDefined()
    expect(day2_14!.quantity).toBe(5) // days 1-5 of segment, day one included
    expect(result.flagFkReporting).toBe(false)
  })

  it('flags läkarintyg when day-8 reached (segment day 8+)', () => {
    const periodDays = days(
      Array.from({ length: 9 }, (_, i): [string, 'sick'] => [`2026-04-${String(6 + i).padStart(2, '0')}`, 'sick']),
    )
    const result = deriveAbsenceLineItems(baseInput({ periodDays }))
    expect(result.flagLakarintyg).toBe(true)
  })

  it('flags FK reporting when segment passes day 14', () => {
    // 16 consecutive sick days
    const periodDays = days(
      Array.from({ length: 16 }, (_, i): [string, 'sick'] => {
        const day = String(6 + i).padStart(2, '0')
        return [`2026-04-${day}`, 'sick']
      }),
    )
    const result = deriveAbsenceLineItems(baseInput({ periodDays }))
    expect(result.flagFkReporting).toBe(true)
    const day15 = result.lineItems.find(li => li.item_type === 'sick_day15_plus')
    expect(day15).toBeDefined()
    expect(day15!.quantity).toBe(2) // days 15, 16
  })

  it('suppresses karens via återinsjuknande when segment started in lookback', () => {
    // Prior segment: Apr 1-3. Current period sick day: Apr 6 (gap 3 days → merge).
    // Segment now spans Apr 1-6. Period day Apr 6 is segment day 6 → day-2-14, no new karens.
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-06', 'sick']]),
        lookbackSickDates: ['2026-04-01', '2026-04-02', '2026-04-03'],
      }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()
    const day2_14 = result.lineItems.find(li => li.item_type === 'sick_day2_14')
    expect(day2_14).toBeDefined()
    expect(day2_14!.quantity).toBe(1)
  })

  it('suppresses karens when högriskskydd cap reached', () => {
    // 10 prior single-day karens-eligible periods, each separated by >5 days
    const lookback: string[] = []
    for (let i = 0; i < 10; i++) {
      // periods on the 1st of each prior month
      const month = ((4 - 1 + 12 - i - 1) % 12) + 1 // months 3, 2, 1, 12, ...
      const year = i < 3 ? 2026 : 2025
      lookback.push(`${year}-${String(month).padStart(2, '0')}-01`)
    }
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-15', 'sick']]),
        lookbackSickDates: lookback,
      }),
    )
    // 10 prior karens in 12-month window → this 11th is suppressed
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()
  })
})

describe('deriveAbsenceLineItems: cutover karensPeriodsAdjustment', () => {
  it('suppresses karens when the adjustment alone reaches the cap', () => {
    // Mid-year switcher with 10 karens periods in the previous system and no
    // imported absence rows: the 11th period must be suppressed even though
    // the lookback here is empty.
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-06', 'sick']]),
        karensPeriodsAdjustment: 10,
      }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()
    // Day 1 with suppressed karens is paid normal: no deduction lines at all.
    expect(result.aggregated.sickDays).toBe(1)
  })

  it('combines the adjustment with real lookback segments', () => {
    // 8 imported periods + adjustment 2 = 10: cap reached, karens suppressed.
    const lookback: string[] = []
    for (let i = 0; i < 8; i++) {
      const month = ((4 - 1 + 12 - i - 1) % 12) + 1
      const year = i < 3 ? 2026 : 2025
      lookback.push(`${year}-${String(month).padStart(2, '0')}-01`)
    }
    const capped = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-15', 'sick']]),
        lookbackSickDates: lookback,
        karensPeriodsAdjustment: 2,
      }),
    )
    expect(capped.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()

    // Adjustment 1 leaves the count at 9: karens still deducted.
    const belowCap = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-15', 'sick']]),
        lookbackSickDates: lookback,
        karensPeriodsAdjustment: 1,
      }),
    )
    expect(belowCap.lineItems.find(li => li.item_type === 'sick_karens')).toBeDefined()
  })

  it('zero/absent adjustment changes nothing', () => {
    const withZero = deriveAbsenceLineItems(
      baseInput({ periodDays: days([['2026-04-06', 'sick']]), karensPeriodsAdjustment: 0 }),
    )
    const without = deriveAbsenceLineItems(
      baseInput({ periodDays: days([['2026-04-06', 'sick']]) }),
    )
    expect(withZero.lineItems).toEqual(without.lineItems)
  })
})

describe('deriveAbsenceLineItems: karens cap, carry and partial days', () => {
  it('keeps suppressing karens for every period past the högriskskydd cap in one month', () => {
    // 10 prior single-day periods, each more than 5 days apart, inside the
    // 12-month window: the 11th and 12th periods in the month are both
    // suppressed, and the suppressed 11th still counts toward the window.
    const lookback = Array.from({ length: 10 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 5 + i * 10))
      return d.toISOString().slice(0, 10)
    })
    const result = deriveAbsenceLineItems(
      baseInput({
        lookbackSickDates: lookback,
        periodDays: days([
          ['2026-07-06', 'sick'],
          ['2026-07-20', 'sick'],
        ]),
      }),
    )
    expect(result.lineItems.filter(li => li.item_type === 'sick_karens')).toHaveLength(0)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.quantity).toBe(2)
  })

  // 30 000 kr, divisor 21: daily 1428.57, sjuklön/day 1142.86,
  // karensavdrag 20 % of a week's sjuklön = 1107.69.
  it('caps the karensavdrag at the sjuklön the period yields (SjLL 6 §)', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 1 }] }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')
    const dayOne = result.lineItems.find(li => li.item_type === 'sick_day2_14')
    // One hour of an 8 h day: lost 178.57, sjuklön 142.86. The karens can
    // only take the 142.86 that exists, so the employee loses exactly the
    // hour, never more.
    expect(karens!.amount).toBe(-142.86)
    expect(dayOne!.quantity).toBe(0.13)
    expect(result.lineItems.reduce((sum, li) => sum + li.amount, 0)).toBeCloseTo(-178.57, 1)
  })

  it('carries the unconsumed karens into the next month of the same period', () => {
    const june = deriveAbsenceLineItems(
      baseInput({ periodDays: [{ absence_date: '2026-06-30', absence_type: 'sick', hours: 1 }] }),
    )
    const july = deriveAbsenceLineItems(
      baseInput({
        periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }],
        lookbackSickDates: ['2026-06-30'],
        lookbackSickDays: [{ absence_date: '2026-06-30', absence_type: 'sick', hours: 1 }],
      }),
    )
    const juneKarens = june.lineItems.find(li => li.item_type === 'sick_karens')!.amount
    const julyKarens = july.lineItems.find(li => li.item_type === 'sick_karens')!.amount
    expect(juneKarens).toBe(-142.86)
    expect(julyKarens).toBe(-964.83)
    expect(r2(juneKarens + julyKarens)).toBe(-1107.69)
  })

  it('does not deduct a second karens when the lookback day already absorbed it', () => {
    const july = deriveAbsenceLineItems(
      baseInput({
        periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }],
        lookbackSickDates: ['2026-06-30'],
      }),
    )
    expect(july.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()
    expect(july.lineItems.find(li => li.item_type === 'sick_day2_14')!.quantity).toBe(1)
  })

  it.each(['vab', 'parental', 'unpaid_leave'] as const)(
    'weights a partial %s day by hours but reports it as one day',
    (absence_type) => {
      const full = deriveAbsenceLineItems(
        baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type, hours: 8 }] }),
      )
      const half = deriveAbsenceLineItems(
        baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type, hours: 4 }] }),
      )
      expect(half.lineItems[0].quantity).toBe(0.5)
      expect(half.lineItems[0].amount).toBeCloseTo(full.lineItems[0].amount / 2, 1)
      expect(half.aggregated).toEqual(full.aggregated)
    },
  )

  it('counts whole dates, not weighted hours, toward the 120-day semestergrundande cap', () => {
    // 119 dates YTD plus two half days: the first half day is date 120 and
    // still semestergrundande, the second is date 121 and is not. The
    // weighted deduction is one day in total, split half and half.
    const result = deriveAbsenceLineItems(
      baseInput({
        vabDaysYtd: 119,
        periodDays: [
          { absence_date: '2026-07-01', absence_type: 'vab', hours: 4 },
          { absence_date: '2026-07-02', absence_type: 'vab', hours: 4 },
        ],
      }),
    )
    const vab = result.lineItems.filter(li => li.item_type === 'vab')
    expect(vab).toHaveLength(2)
    expect(vab[0]).toMatchObject({ quantity: 0.5, is_vacation_basis: false, description: 'VAB (1 dagar)' })
    expect(vab[1]).toMatchObject({
      quantity: 0.5,
      is_vacation_basis: true,
      description: 'VAB (1 dagar, ej semestergrundande)',
    })
    expect(r2(vab[0].amount + vab[1].amount)).toBe(-1428.58) // 2 x r(714.285), one öre off the whole day
    expect(result.aggregated.vabDays).toBe(2)
  })

  it('uses the employee schedule for the day length and never counts more than a day', () => {
    const sixHourDay = deriveAbsenceLineItems(
      baseInput({ hoursPerDay: 6, periodDays: [{ absence_date: '2026-07-01', absence_type: 'vab', hours: 3 }] }),
    )
    expect(sixHourDay.lineItems[0].quantity).toBe(0.5)
    const overbooked = deriveAbsenceLineItems(
      baseInput({ hoursPerDay: 6, periodDays: [{ absence_date: '2026-07-01', absence_type: 'vab', hours: 8 }] }),
    )
    expect(overbooked.lineItems[0].quantity).toBe(1)
  })
})

const r2 = (x: number) => Math.round(x * 100) / 100

describe('deriveAbsenceLineItems: VAB', () => {
  it('emits VAB line item with deduction', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([
          ['2026-04-10', 'vab'],
          ['2026-04-11', 'vab'],
        ]),
      }),
    )
    const vab = result.lineItems.filter(li => li.item_type === 'vab')
    expect(vab).toHaveLength(1)
    expect(vab[0].quantity).toBe(2)
    expect(vab[0].amount).toBe(-2857.14)
    expect(vab[0].description).toBe('VAB (2 dagar)')
    expect(vab[0].is_vacation_basis).toBe(false) // ≤120 days YTD: the base keeps the pay
    expect(result.aggregated.vabDays).toBe(2)
  })

  it('marks VAB non-vacation-basis when YTD >= 120', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-10', 'vab']]),
        vabDaysYtd: 120,
      }),
    )
    const vab = result.lineItems.filter(li => li.item_type === 'vab')
    expect(vab).toHaveLength(1)
    expect(vab[0].is_vacation_basis).toBe(true) // past the cap: the deduction lowers the base
    expect(vab[0].quantity).toBe(1)
    expect(vab[0].description).toBe('VAB (1 dagar, ej semestergrundande)')
  })
})

// SemL 17 a § första stycket 1 (VAB) and 3 (parental leave): 120 calendar
// dates. The same split rule serves both; the table carries what differs. A
// qualifying row stays out of the procentregeln base (is_vacation_basis
// false), a row past the cap lowers it (true): SemL 16 b §.
const capCases = [
  {
    label: 'VAB',
    absence_type: 'vab' as const,
    item_type: 'vab' as const,
    ytd: (n: number): Partial<DeriveInput> => ({ vabDaysYtd: n }),
  },
  {
    label: 'Föräldraledighet',
    absence_type: 'parental' as const,
    item_type: 'parental_leave' as const,
    ytd: (n: number): Partial<DeriveInput> => ({ parentalDaysPregnancyYtd: n }),
  },
]

describe.each(capCases)('deriveAbsenceLineItems: 120-date cap split ($label)', ({ label, absence_type, item_type, ytd }) => {
  const twoDates = () => days([
    ['2026-07-01', absence_type],
    ['2026-07-02', absence_type],
  ])

  it('splits the row when the 120th date falls inside the period', () => {
    // 119 dates YTD: July 1 is date 120 (still semestergrundande), July 2 is
    // date 121 (not). One row per part, amounts add up to the unsplit row.
    const split = deriveAbsenceLineItems(baseInput({ ...ytd(119), periodDays: twoDates() }))
    const whole = deriveAbsenceLineItems(baseInput({ ...ytd(0), periodDays: twoDates() }))
    const rows = split.lineItems.filter(li => li.item_type === item_type)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      item_type,
      description: `${label} (1 dagar)`,
      quantity: 1,
      amount: -1428.57,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
      is_net_deduction: false,
    })
    expect(rows[1]).toEqual({
      item_type,
      description: `${label} (1 dagar, ej semestergrundande)`,
      quantity: 1,
      amount: -1428.57,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      is_gross_deduction: true,
      is_net_deduction: false,
    })
    const wholeRows = whole.lineItems.filter(li => li.item_type === item_type)
    expect(wholeRows).toHaveLength(1)
    expect(r2(rows[0].amount + rows[1].amount)).toBe(wholeRows[0].amount)
    // The reported date count stays the whole period.
    expect(split.aggregated).toEqual(whole.aggregated)
  })

  it('keeps one qualifying row when the period ends exactly on date 120', () => {
    // 118 dates YTD plus two half days: dates 119 and 120, both qualify.
    const result = deriveAbsenceLineItems(
      baseInput({
        ...ytd(118),
        periodDays: [
          { absence_date: '2026-07-01', absence_type, hours: 4 },
          { absence_date: '2026-07-02', absence_type, hours: 4 },
        ],
      }),
    )
    const rows = result.lineItems.filter(li => li.item_type === item_type)
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(1)
    expect(rows[0].is_vacation_basis).toBe(false)
    expect(rows[0].description).toBe(`${label} (2 dagar)`)
  })

  it('emits one non-qualifying row when the cap was already reached', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ ...ytd(120), periodDays: days([['2026-07-01', absence_type]]) }),
    )
    const rows = result.lineItems.filter(li => li.item_type === item_type)
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(1)
    expect(rows[0].amount).toBe(-1428.57)
    expect(rows[0].is_vacation_basis).toBe(true)
    expect(rows[0].description).toBe(`${label} (1 dagar, ej semestergrundande)`)
  })

  it('walks the rows in date order regardless of input order', () => {
    // July 2 (a full day) is listed first, July 1 (a half day) second. Date
    // 120 is July 1, so the qualifying part must be the half day.
    const result = deriveAbsenceLineItems(
      baseInput({
        ...ytd(119),
        periodDays: [
          { absence_date: '2026-07-02', absence_type, hours: 8 },
          { absence_date: '2026-07-01', absence_type, hours: 4 },
        ],
      }),
    )
    const rows = result.lineItems.filter(li => li.item_type === item_type)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ quantity: 0.5, is_vacation_basis: false })
    expect(rows[1]).toMatchObject({ quantity: 1, is_vacation_basis: true })
  })

  it('does not disturb the other absence rows', () => {
    // A sick day and an unpaid day next to a split period: the split adds
    // exactly one row and leaves everything else as it was.
    const other = days([
      ['2026-07-06', 'sick'],
      ['2026-07-07', 'unpaid_leave'],
    ])
    const split = deriveAbsenceLineItems(baseInput({ ...ytd(119), periodDays: [...other, ...twoDates()] }))
    const whole = deriveAbsenceLineItems(baseInput({ ...ytd(0), periodDays: [...other, ...twoDates()] }))
    const others = (items: typeof split.lineItems) => items.filter(li => li.item_type !== item_type)
    expect(others(split.lineItems)).toEqual(others(whole.lineItems))
    expect(split.lineItems.length).toBe(whole.lineItems.length + 1)
  })
})

describe('deriveAbsenceLineItems: parental', () => {
  it('emits parental line item with deduction', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([
          ['2026-04-10', 'parental'],
          ['2026-04-11', 'parental'],
          ['2026-04-12', 'parental'],
        ]),
      }),
    )
    const parental = result.lineItems.find(li => li.item_type === 'parental_leave')
    expect(parental).toBeDefined()
    expect(parental!.quantity).toBe(3)
    expect(result.aggregated.parentalDays).toBe(3)
  })
})

describe('deriveAbsenceLineItems: unpaid_leave', () => {
  it('emits unpaid_leave line item with a per-day daily-rate deduction', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 42000, // dailyRate = 42 000 / 21 = 2 000
        periodDays: days([
          ['2026-04-10', 'unpaid_leave'],
          ['2026-04-13', 'unpaid_leave'],
        ]),
      }),
    )
    const unpaid = result.lineItems.find(li => li.item_type === 'unpaid_leave')
    expect(unpaid).toBeDefined()
    expect(unpaid!.quantity).toBe(2)
    expect(unpaid!.amount).toBe(-4000)
    // false: engine's Step 3 absence sum already subtracts unpaid_leave;
    // setting the flag would double-count in Step 4 totalGrossDeductions.
    expect(unpaid!.is_gross_deduction).toBe(false)
    expect(unpaid!.is_vacation_basis).toBe(true) // not semesterlönegrundande: lowers the base
    expect(result.aggregated.unpaidLeaveDays).toBe(2)
  })
})

describe('deriveAbsenceLineItems: empty', () => {
  it('returns empty result for no absence', () => {
    const result = deriveAbsenceLineItems(baseInput())
    expect(result.lineItems).toEqual([])
    expect(result.aggregated).toEqual({ sickDays: 0, vabDays: 0, parentalDays: 0, unpaidLeaveDays: 0 })
    expect(result.flagFkReporting).toBe(false)
    expect(result.flagLakarintyg).toBe(false)
  })
})

// ============================================================
// Company calculation conventions (lib/salary/calculation-policy.ts)
// ============================================================

import { DEFAULT_SALARY_CALCULATION_POLICY, SalaryCalculationPolicySchema } from '../calculation-policy'

/** Mon-Fri rows between two dates, one type, same hours. */
const weekdayRows = (
  start: string,
  end: string,
  absence_type: AbsenceDay['absence_type'],
  hours = 8,
): AbsenceDay[] => {
  const rows: AbsenceDay[] = []
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) {
    if (new Date(ms).getUTCDay() % 6 !== 0) {
      rows.push({ absence_date: new Date(ms).toISOString().slice(0, 10), absence_type, hours })
    }
  }
  return rows
}

const policy = (over: Record<string, string>) => SalaryCalculationPolicySchema.parse(over)

describe('deriveAbsenceLineItems: calculation policy defaults are a no-op', () => {
  it('produces the identical result with the default policy and schedule inputs supplied', () => {
    const periodDays: AbsenceDay[] = [
      ...weekdayRows('2026-07-01', '2026-07-03', 'sick'),
      { absence_date: '2026-07-06', absence_type: 'vab', hours: 4 },
      ...weekdayRows('2026-07-07', '2026-07-08', 'parental'),
      { absence_date: '2026-07-09', absence_type: 'unpaid_leave', hours: 8 },
    ]
    const plain = deriveAbsenceLineItems(baseInput({ periodDays, lookbackSickDates: ['2026-06-25'] }))
    const withDefaults = deriveAbsenceLineItems(
      baseInput({
        periodDays,
        lookbackSickDates: ['2026-06-25'],
        calculationPolicy: DEFAULT_SALARY_CALCULATION_POLICY,
        hoursPerDay: 8,
        hoursPerWeek: 40,
        workdaysPerWeek: 5,
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        contextDays: weekdayRows('2026-08-03', '2026-08-14', 'parental'),
      }),
    )
    expect(withDefaults).toEqual(plain)
  })
})

describe('deriveAbsenceLineItems: sick_rate = annual_hourly', () => {
  it('prices sick days 1-14 per hour at månadslön × 12 / (52 × veckoarbetstid), karens unchanged', () => {
    // 30 000 kr, 40 h: timlön 173,08, sjuklön per timme 138,46. One 8 h day:
    // lost pay 1 384,64, sjuklön 1 107,68, deduction 276,96. The weekly
    // karens (1 107,69) is capped at the sjuklön the day yields.
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }],
        hoursPerWeek: 40,
        calculationPolicy: policy({ sick_rate: 'annual_hourly' }),
      }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(-276.96)
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-1107.68)
    // Default convention for the same day: daily rate 1 428,57.
    const plain = deriveAbsenceLineItems(baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }] }))
    expect(plain.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(-285.71)
    expect(plain.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-1107.69)
  })

  it('leaves day 15+ on the daily rate unless the calendar long-leave convention is on', () => {
    const lookback = weekdayRows('2026-06-01', '2026-06-30', 'sick').map(d => d.absence_date)
    const periodDays = weekdayRows('2026-07-01', '2026-07-03', 'sick')
    const hourly = deriveAbsenceLineItems(
      baseInput({ periodDays, lookbackSickDates: lookback, hoursPerWeek: 40, calculationPolicy: policy({ sick_rate: 'annual_hourly' }) }),
    )
    const plain = deriveAbsenceLineItems(baseInput({ periodDays, lookbackSickDates: lookback }))
    expect(hourly.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount).toBe(
      plain.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount,
    )
  })
})

describe('deriveAbsenceLineItems: long_leave = calendar_after_five_workdays', () => {
  const calendar = policy({ long_leave: 'calendar_after_five_workdays' })

  it('requires a five-day schedule and a complete deviation window', () => {
    const periodDays = weekdayRows('2037-07-27', '2037-07-31', 'parental')
    expect(() =>
      deriveAbsenceLineItems(baseInput({ periodDays, periodStart: '2037-07-01', periodEnd: '2037-07-31', workdaysPerWeek: 4, calculationPolicy: calendar })),
    ).toThrow('femdagarsvecka')
    expect(() => deriveAbsenceLineItems(baseInput({ periodDays, calculationPolicy: calendar }))).toThrow('avvikelseperiod')
  })

  it('judges the five-day threshold with the surrounding context, and leave_context caps it at the window end', () => {
    // 63 000 kr: daily 3 000, calendar 2 071,23. Five parental workdays at the
    // end of July, five more registered for early August.
    const july = weekdayRows('2037-07-27', '2037-07-31', 'parental')
    const august = weekdayRows('2037-08-03', '2037-08-07', 'parental')
    const input = baseInput({
      monthlySalary: 63000,
      periodStart: '2037-07-01',
      periodEnd: '2037-07-31',
      periodDays: july,
      contextDays: august,
      calculationPolicy: calendar,
    })
    // Ten working days in all: calendar rate on the five in-window days.
    expect(deriveAbsenceLineItems(input).lineItems[0].amount).toBe(-10356.15)
    // Only days through the window end count: a five-day episode, daily rate.
    expect(
      deriveAbsenceLineItems({ ...input, calculationPolicy: policy({ long_leave: 'calendar_after_five_workdays', leave_context: 'through_deviation_end' }) })
        .lineItems[0].amount,
    ).toBe(-15000)
    // Prior-month context is before the window end and still counts.
    const june = weekdayRows('2037-06-22', '2037-06-30', 'parental')
    const earlyJuly = weekdayRows('2037-07-01', '2037-07-03', 'parental')
    expect(
      deriveAbsenceLineItems({
        ...input,
        periodDays: earlyJuly,
        contextDays: june,
        calculationPolicy: policy({ long_leave: 'calendar_after_five_workdays', leave_context: 'through_deviation_end' }),
      }).lineItems[0].amount,
    ).toBe(-6213.69)
  })

  it('prices a short episode exactly as the default convention does', () => {
    const periodDays = weekdayRows('2037-07-13', '2037-07-17', 'unpaid_leave')
    const withPolicy = deriveAbsenceLineItems(baseInput({ periodDays, periodStart: '2037-07-01', periodEnd: '2037-07-31', calculationPolicy: calendar }))
    const plain = deriveAbsenceLineItems(baseInput({ periodDays }))
    expect(withPolicy.lineItems).toEqual(plain.lineItems)
  })

  it('prices unpaid leave longer than five working days per calendar day', () => {
    // 30 000 kr: calendar rate 986,30; Mon 6 to Fri 17 July = 12 calendar days.
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: weekdayRows('2037-07-06', '2037-07-17', 'unpaid_leave'),
        periodStart: '2037-07-01',
        periodEnd: '2037-07-31',
        calculationPolicy: calendar,
      }),
    )
    expect(result.lineItems).toHaveLength(1)
    expect(result.lineItems[0].amount).toBe(-11835.6)
    expect(result.lineItems[0].quantity).toBe(10)
  })

  it('shares one calendar-rate total over the 120-date parental split by weighted days', () => {
    const periodDays = weekdayRows('2037-07-27', '2037-07-31', 'parental')
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays,
        contextDays: weekdayRows('2037-08-03', '2037-08-07', 'parental'),
        parentalDaysPregnancyYtd: 118,
        periodStart: '2037-07-01',
        periodEnd: '2037-07-31',
        calculationPolicy: calendar,
      }),
    )
    // 30 000 kr: five calendar days at 986,30 = 4 931,50 in all.
    const parental = result.lineItems.filter(li => li.item_type === 'parental_leave')
    expect(parental).toHaveLength(2)
    expect(parental[0].is_vacation_basis).toBe(false)
    expect(parental[0].amount).toBe(-1972.6)
    expect(parental[1].is_vacation_basis).toBe(true)
    expect(parental[1].amount).toBe(-2958.9)
    expect(Math.round((parental[0].amount + parental[1].amount) * 100) / 100).toBe(-4931.5)
  })

  it('prices sick day 15+ per calendar day from its first day, keeping partial extents continuous', () => {
    // 48 000 kr: calendar rate 1 578,08. Sick every day of June (6 h) and July
    // (6 h the first four days, then 1 h): all of July is Försäkringskassan
    // time, 4 days at 3/4 + 27 days at 1/8, and the karens was consumed in June.
    const lookback = Array.from({ length: 30 }, (_, i) => `2037-06-${String(i + 1).padStart(2, '0')}`)
    const periodDays: AbsenceDay[] = Array.from({ length: 31 }, (_, i) => ({
      absence_date: `2037-07-${String(i + 1).padStart(2, '0')}`,
      absence_type: 'sick',
      hours: i < 4 ? 6 : 1,
    }))
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 48000,
        periodDays,
        lookbackSickDates: lookback,
        lookbackSickDays: lookback.map(date => ({ absence_date: date, absence_type: 'sick', hours: 6 })),
        periodStart: '2037-07-01',
        periodEnd: '2037-07-31',
        calculationPolicy: calendar,
      }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount).toBe(-10060.26)
    expect(result.lineItems.some(li => li.item_type === 'sick_karens')).toBe(false)
  })

  it('separates a long Försäkringskassan episode from a new employer-paid episode in one month (hourly sick rate)', () => {
    // 48 000 kr, 3 h rows: June on sick leave, July 1-10 still day 15+, then a
    // new sjuklöneperiod from Monday 27 July with its own karens.
    const prior = weekdayRows('2037-06-01', '2037-06-30', 'sick', 3)
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 48000,
        periodStart: '2037-07-01',
        periodEnd: '2037-07-31',
        calculationPolicy: policy({ long_leave: 'calendar_after_five_workdays', sick_rate: 'annual_hourly' }),
        hoursPerWeek: 40,
        lookbackSickDates: prior.map(d => d.absence_date),
        lookbackSickDays: prior,
        periodDays: [...weekdayRows('2037-07-01', '2037-07-10', 'sick', 3), ...weekdayRows('2037-07-27', '2037-07-31', 'sick', 3)],
      }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount).toBe(-5917.8)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(-830.7)
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-1772.31)
  })
})

describe('deriveAbsenceLineItems: one working day a week, continuously sick (#2876)', () => {
  // 4 h on one day a week, 10 000 a month (degree 100 with the actual pay).
  // Sick on five consecutive Wednesdays: one illness, one sjuklöneperiod.
  const wednesdays = ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']
  const oneDayAWeek = (over: Partial<DeriveInput> = {}): DeriveInput =>
    baseInput({
      monthlySalary: 10000,
      periodDays: wednesdays.map(d => ({ absence_date: d, absence_type: 'sick' as const, hours: 4 })),
      hoursPerDay: 4,
      hoursPerWeek: 4,
      workdaysPerWeek: 1,
      dailyDivisor: 4.33,
      ...over,
    })

  it('is one sjuklöneperiod with one karensavdrag, sjuklön to day 14 and full deduction from day 15', () => {
    const result = deriveAbsenceLineItems(oneDayAWeek())
    const karens = result.lineItems.filter(li => li.item_type === 'sick_karens')
    expect(karens).toHaveLength(1)
    expect(karens[0].description).toBe('Karensavdrag (2026-09-02)')
    // 20 % of one week's sjuklön on 10 000: r(r(10000 x 12 / 52 x 0.8) x 0.2).
    expect(karens[0].amount).toBe(-369.23)

    // 2 and 9 September are segment days 1 and 8: sjuklön. 16, 23 and 30
    // September are days 15, 22 and 29: the employer pays nothing.
    const sjuklon = result.lineItems.find(li => li.item_type === 'sick_day2_14')!
    expect(sjuklon.quantity).toBe(2)
    const day15 = result.lineItems.find(li => li.item_type === 'sick_day15_plus')!
    expect(day15.quantity).toBe(3)
    // Three full days at 10000 / 4.33.
    expect(day15.amount).toBeCloseTo(-3 * (10000 / 4.33), 0)
    expect(result.flagLakarintyg).toBe(true)
    expect(result.flagFkReporting).toBe(true)
  })

  it('was five periods with five karensavdrag under the fixed five-day rule (regression proof)', () => {
    const result = deriveAbsenceLineItems(oneDayAWeek({ workdaysPerWeek: 5 }))
    expect(result.lineItems.filter(li => li.item_type === 'sick_karens')).toHaveLength(5)
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')).toBeUndefined()
  })

  it('continues a period that began in the previous month without a new karensavdrag', () => {
    // First sick Wednesday 26 August (lookback), 2 September is day 8 of the
    // same period: the prior day's sjuklön already absorbed the karens.
    const result = deriveAbsenceLineItems(
      oneDayAWeek({
        lookbackSickDates: ['2026-08-26'],
        lookbackSickDays: [{ absence_date: '2026-08-26', absence_type: 'sick', hours: 4 }],
      }),
    )
    expect(result.lineItems.filter(li => li.item_type === 'sick_karens')).toHaveLength(0)
    const sjuklon = result.lineItems.find(li => li.item_type === 'sick_day2_14')!
    // 2 September only (day 8); 9 September is day 15.
    expect(sjuklon.quantity).toBe(1)
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')!.quantity).toBe(4)
  })

  it('a skipped working day (she worked) still starts a new period', () => {
    const result = deriveAbsenceLineItems(
      oneDayAWeek({
        periodDays: ['2026-09-02', '2026-09-16'].map(d => ({
          absence_date: d,
          absence_type: 'sick' as const,
          hours: 4,
        })),
      }),
    )
    expect(result.lineItems.filter(li => li.item_type === 'sick_karens')).toHaveLength(2)
  })
})

const r = (x: number) => Math.round(x * 100) / 100

describe('calculateVabDeduction', () => {
  it('calculates daily rate deduction', () => {
    const result = calculateVabDeduction(30000, 3)
    const expectedDeduction = r(30000 / 21 * 3)
    expect(result.deduction).toBe(expectedDeduction)
  })

  it('marks as semesterlönegrundande within 120 days', () => {
    const result = calculateVabDeduction(30000, 5, 100)
    expect(result.semesterGrundande).toBe(true) // 100 + 5 = 105 ≤ 120
  })

  it('marks as not semesterlönegrundande after 120 days', () => {
    const result = calculateVabDeduction(30000, 5, 118)
    expect(result.semesterGrundande).toBe(false) // 118 + 5 = 123 > 120
  })
})

describe('calculateParentalLeaveDeduction', () => {
  it('calculates daily rate deduction', () => {
    const result = calculateParentalLeaveDeduction(30000, 10)
    // Daily rate is rounded first, then multiplied: r(r(30000/21) * 10)
    const dailyRate = r(30000 / 21)
    const expectedDeduction = r(dailyRate * 10)
    expect(result.deduction).toBe(expectedDeduction)
  })

  it('marks as semesterlönegrundande within 120 days per pregnancy', () => {
    const result = calculateParentalLeaveDeduction(30000, 10, 100)
    expect(result.semesterGrundande).toBe(true) // 100 + 10 = 110 ≤ 120
  })
})

// ============================================================
// Hourly pay (#60 part A, SjLL 6 §)
// ============================================================

describe('deriveAbsenceLineItems: hourly pay', () => {
  /** An hourly employee at 200 kr/h on a 40 h, five-day week. */
  const hourlyInput = (over: Partial<DeriveInput> = {}): DeriveInput =>
    baseInput({
      monthlySalary: 0,
      salaryType: 'hourly',
      hourlyRate: 200,
      hoursPerDay: 8,
      hoursPerWeek: 40,
      workdaysPerWeek: 5,
      ...over,
    })
  const sickRows = (entries: Array<[string, number]>): AbsenceDay[] =>
    entries.map(([absence_date, hours]) => ({ absence_date, absence_type: 'sick', hours }))
  const total = (lines: { amount: number }[]) => r2(lines.reduce((sum, li) => sum + li.amount, 0))

  it('pays 80 % of timlön for the sick hours and takes 20 % of a week\'s sjuklön as karensavdrag', () => {
    // Was 0 kr: sjuklön priced from monthly_salary, which is 0 for timlön.
    const result = deriveAbsenceLineItems(
      hourlyInput({ periodDays: sickRows([['2026-04-06', 8], ['2026-04-07', 8], ['2026-04-08', 8]]) }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')!
    const sjuklon = result.lineItems.find(li => li.item_type === 'sick_day2_14')!
    // 3 x 8 h x 200 x 0,8 = 3 840; karens 0,2 x 0,8 x 200 x 40 = 1 280.
    expect(sjuklon.amount).toBe(3840)
    expect(sjuklon.quantity).toBe(24)
    expect(sjuklon.description).toBe('Sjuklön dag 1-14 (3 dagar, 24 tim)')
    expect(sjuklon).toMatchObject({ is_taxable: true, is_avgift_basis: true, is_vacation_basis: false })
    expect(karens.amount).toBe(-1280)
    expect(karens.description).toBe('Karensavdrag (2026-04-06, 40 tim/vecka)')
    expect(total(result.lineItems)).toBe(2560)
    expect(result.aggregated.sickDays).toBe(3)
  })

  it('takes the karensavdrag from the weekly hours on the schedule (28 h at 120 kr/h)', () => {
    const result = deriveAbsenceLineItems(
      hourlyInput({
        hourlyRate: 120,
        hoursPerDay: 7,
        hoursPerWeek: 28,
        workdaysPerWeek: 4,
        periodDays: sickRows([['2026-04-06', 7], ['2026-04-07', 7], ['2026-04-08', 7]]),
      }),
    )
    // A week's sjuklön 120 x 0,8 x 28 = 2 688, karens 20 % = 537,60.
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-537.6)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(2016)
  })

  it('prices the hours on the row, also a shift longer than the average day', () => {
    const result = deriveAbsenceLineItems(
      hourlyInput({ periodDays: sickRows([['2026-04-06', 10], ['2026-04-07', 3.5]]) }),
    )
    const sjuklon = result.lineItems.find(li => li.item_type === 'sick_day2_14')!
    expect(sjuklon.quantity).toBe(13.5)
    expect(sjuklon.amount).toBe(2160) // 13,5 x 200 x 0,8
  })

  it('caps the karensavdrag at the sjuklön the period yields', () => {
    const result = deriveAbsenceLineItems(hourlyInput({ periodDays: sickRows([['2026-04-06', 4]]) }))
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(640)
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-640)
    expect(total(result.lineItems)).toBe(0)
  })

  it('carries the unconsumed karensavdrag into the next month of the same period', () => {
    const july = deriveAbsenceLineItems(
      hourlyInput({
        periodDays: sickRows([['2026-07-01', 8]]),
        lookbackSickDates: ['2026-06-30'],
        lookbackSickDays: sickRows([['2026-06-30', 4]]),
      }),
    )
    // June's 4 h absorbed 640 of the 1 280; July takes the remaining 640.
    expect(july.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-640)
    expect(july.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(1280)
  })

  it('takes no karensavdrag past the högriskskydd cap and keeps the full sjuklön', () => {
    const lookback = Array.from({ length: 10 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 5 + i * 10)).toISOString().slice(0, 10),
    )
    const result = deriveAbsenceLineItems(
      hourlyInput({ lookbackSickDates: lookback, periodDays: sickRows([['2026-07-06', 8]]) }),
    )
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')).toBeUndefined()
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(1280)
  })

  it('pays days 1-14 only and deducts nothing from day 15 (Försäkringskassan)', () => {
    const periodDays = sickRows(
      Array.from({ length: 16 }, (_, i): [string, number] => [`2026-04-${String(6 + i).padStart(2, '0')}`, 8]),
    )
    const result = deriveAbsenceLineItems(hourlyInput({ periodDays }))
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(17920) // 14 x 8 x 160
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')).toBeUndefined()
    expect(result.flagFkReporting).toBe(true)
    expect(result.flagLakarintyg).toBe(true)
  })

  it('never prices hourly sick pay from a monthly salary left on the employee', () => {
    const periodDays = sickRows([['2026-04-06', 8], ['2026-04-07', 8]])
    const clean = deriveAbsenceLineItems(hourlyInput({ periodDays }))
    const stale = deriveAbsenceLineItems(hourlyInput({ periodDays, monthlySalary: 30000 }))
    expect(stale.lineItems).toEqual(clean.lineItems)
  })

  it('refuses a sick row without hours rather than paying 0 kr', () => {
    for (const hours of [Number.NaN, 0]) {
      const run = () =>
        deriveAbsenceLineItems(hourlyInput({ periodDays: sickRows([['2026-04-06', 8], ['2026-04-07', hours]]) }))
      expect(run).toThrow(AbsenceInputError)
      expect(run).toThrow('Sjukdagen 2026-04-07 saknar timmar')
    }
  })

  it('refuses sick days without a timlön rather than paying 0 kr', () => {
    for (const hourlyRate of [null, 0, undefined]) {
      const run = () => deriveAbsenceLineItems(hourlyInput({ hourlyRate, periodDays: sickRows([['2026-04-06', 8]]) }))
      expect(run).toThrow(AbsenceInputError)
      expect(run).toThrow('Timlön saknas')
    }
  })

  it('needs no timlön when the period has no sick days', () => {
    const result = deriveAbsenceLineItems(
      hourlyInput({ hourlyRate: null, periodDays: [{ absence_date: '2026-04-06', absence_type: 'vab', hours: 8 }] }),
    )
    expect(result.lineItems.map(li => li.item_type)).toEqual(['vab'])
  })
})

describe('deriveAbsenceLineItems: monthly pay is unchanged by the hourly model', () => {
  it('gives the identical result whether salaryType is omitted or monthly, with any hourlyRate', () => {
    const periodDays: AbsenceDay[] = [
      { absence_date: '2026-04-06', absence_type: 'sick', hours: 8 },
      { absence_date: '2026-04-07', absence_type: 'sick', hours: 4 },
      ...Array.from({ length: 14 }, (_, i): AbsenceDay => ({
        absence_date: `2026-04-${String(8 + i).padStart(2, '0')}`,
        absence_type: 'sick',
        hours: 8,
      })),
      { absence_date: '2026-04-27', absence_type: 'vab', hours: 8 },
      { absence_date: '2026-04-28', absence_type: 'parental', hours: 8 },
      { absence_date: '2026-04-29', absence_type: 'unpaid_leave', hours: 4 },
    ]
    const input = baseInput({
      periodDays,
      lookbackSickDates: ['2026-03-02'],
      lookbackSickDays: [{ absence_date: '2026-03-02', absence_type: 'sick', hours: 8 }],
    })
    const omitted = deriveAbsenceLineItems(input)
    const monthly = deriveAbsenceLineItems({ ...input, salaryType: 'monthly', hourlyRate: 250 })
    expect(monthly).toEqual(omitted)
    // The monthly model still deducts: karens and the 20 % gap are negative.
    expect(omitted.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-1107.69)
    expect(omitted.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBeLessThan(0)
    expect(omitted.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount).toBeLessThan(0)
  })
})

// ============================================================
// The procentregeln base (#60 part C, SemL 16 b § andra och tredje stycket,
// 17-17 a §§): which absence rows enter the base, and the hours of
// semesterlönegrundande absence hourly pay adds to it
// ============================================================

describe('deriveAbsenceLineItems: semesterlönegrundande frånvaro (#60 C)', () => {
  /** is_vacation_basis per item_type; a split type lists its rows in order. */
  const flags = (lines: { item_type: string; is_vacation_basis: boolean }[]) =>
    lines.reduce<Record<string, boolean[]>>((acc, li) => {
      ;(acc[li.item_type] ??= []).push(li.is_vacation_basis)
      return acc
    }, {})

  describe('monthly pay: a qualifying deduction stays out of the base, one that does not qualify enters it', () => {
    it('sick days 1-14, the karensavdrag and day 15+ all keep the base whole (17 §)', () => {
      const periodDays = Array.from({ length: 16 }, (_, i): AbsenceDay => ({
        absence_date: `2026-04-${String(6 + i).padStart(2, '0')}`,
        absence_type: 'sick',
        hours: 8,
      }))
      const result = deriveAbsenceLineItems(baseInput({ periodDays }))
      expect(flags(result.lineItems)).toEqual({
        sick_karens: [false],
        sick_day2_14: [false],
        sick_day15_plus: [false],
      })
      expect(result.qualifyingAbsenceHours).toBe(0)
    })

    it('VAB within the 120 dates keeps the base whole, past them lowers it (17 a § 1 p.)', () => {
      const within = deriveAbsenceLineItems(baseInput({ vabDaysYtd: 10, periodDays: days([['2026-04-10', 'vab']]) }))
      const past = deriveAbsenceLineItems(baseInput({ vabDaysYtd: 120, periodDays: days([['2026-04-10', 'vab']]) }))
      expect(flags(within.lineItems)).toEqual({ vab: [false] })
      expect(flags(past.lineItems)).toEqual({ vab: [true] })
    })

    it('parental leave within the 120 dates keeps the base whole, past them lowers it (17 a § 3 p.)', () => {
      const split = deriveAbsenceLineItems(
        baseInput({
          parentalDaysPregnancyYtd: 119,
          periodDays: days([['2026-04-09', 'parental'], ['2026-04-10', 'parental']]),
        }),
      )
      expect(flags(split.lineItems)).toEqual({ parental_leave: [false, true] })
    })

    it('unpaid leave is never semesterlönegrundande: it lowers the base', () => {
      const result = deriveAbsenceLineItems(baseInput({ periodDays: days([['2026-04-10', 'unpaid_leave']]) }))
      expect(flags(result.lineItems)).toEqual({ unpaid_leave: [true] })
    })

    it('reports no qualifying hours: the monthly salary already holds the pay', () => {
      const result = deriveAbsenceLineItems(
        baseInput({
          periodDays: days([
            ['2026-04-06', 'sick'],
            ['2026-04-07', 'vab'],
            ['2026-04-08', 'parental'],
            ['2026-04-09', 'unpaid_leave'],
          ]),
        }),
      )
      expect(result.qualifyingAbsenceHours).toBe(0)
    })
  })

  describe('hourly pay: the hours the employee would have worked on qualifying days', () => {
    const hourlyInput = (over: Partial<DeriveInput> = {}): DeriveInput =>
      baseInput({
        monthlySalary: 0,
        salaryType: 'hourly',
        hourlyRate: 200,
        hoursPerDay: 8,
        hoursPerWeek: 40,
        workdaysPerWeek: 5,
        ...over,
      })

    it('counts every sick hour, karens day and day 15+ included, and keeps the 80 % sjuklön out of the base', () => {
      const periodDays: AbsenceDay[] = Array.from({ length: 16 }, (_, i): AbsenceDay => ({
        absence_date: `2026-04-${String(6 + i).padStart(2, '0')}`,
        absence_type: 'sick',
        hours: i === 0 ? 6 : 8,
      }))
      const result = deriveAbsenceLineItems(hourlyInput({ periodDays }))
      // 6 + 15 x 8 = 126 hours; the sjuklön row is pay for qualifying days.
      expect(result.qualifyingAbsenceHours).toBe(126)
      expect(flags(result.lineItems)).toEqual({ sick_karens: [false], sick_day2_14: [false] })
    })

    it('counts VAB hours within the 120 dates only', () => {
      const result = deriveAbsenceLineItems(
        hourlyInput({
          vabDaysYtd: 119,
          periodDays: [
            { absence_date: '2026-04-09', absence_type: 'vab', hours: 5 },
            { absence_date: '2026-04-10', absence_type: 'vab', hours: 8 },
          ],
        }),
      )
      expect(result.qualifyingAbsenceHours).toBe(5)
    })

    it('counts parental hours within the 120 dates only', () => {
      const within = deriveAbsenceLineItems(
        hourlyInput({ periodDays: [{ absence_date: '2026-04-10', absence_type: 'parental', hours: 7.5 }] }),
      )
      const past = deriveAbsenceLineItems(
        hourlyInput({
          parentalDaysPregnancyYtd: 120,
          periodDays: [{ absence_date: '2026-04-10', absence_type: 'parental', hours: 7.5 }],
        }),
      )
      expect(within.qualifyingAbsenceHours).toBe(7.5)
      expect(past.qualifyingAbsenceHours).toBe(0)
    })

    it('counts nothing for unpaid leave: those hours were never earned', () => {
      const result = deriveAbsenceLineItems(
        hourlyInput({ periodDays: [{ absence_date: '2026-04-10', absence_type: 'unpaid_leave', hours: 8 }] }),
      )
      expect(result.qualifyingAbsenceHours).toBe(0)
    })

    it('sums the qualifying types together', () => {
      const result = deriveAbsenceLineItems(
        hourlyInput({
          periodDays: [
            { absence_date: '2026-04-06', absence_type: 'sick', hours: 8 },
            { absence_date: '2026-04-08', absence_type: 'vab', hours: 4 },
            { absence_date: '2026-04-09', absence_type: 'parental', hours: 8 },
            { absence_date: '2026-04-10', absence_type: 'unpaid_leave', hours: 8 },
          ],
        }),
      )
      expect(result.qualifyingAbsenceHours).toBe(20)
    })
  })

  it('reports no qualifying hours without absence', () => {
    expect(deriveAbsenceLineItems(baseInput()).qualifyingAbsenceHours).toBe(0)
    expect(
      deriveAbsenceLineItems(baseInput({ monthlySalary: 0, salaryType: 'hourly', hourlyRate: 200 })).qualifyingAbsenceHours,
    ).toBe(0)
  })
})

/** Every Monday-to-Friday date from `from` to `to`, inclusive: the days a sick row exists on. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t)
    if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

const sickRows = (dates: string[], hours = 8): AbsenceDay[] =>
  dates.map(absence_date => ({ absence_date, absence_type: 'sick' as const, hours }))

const rowOf = (result: ReturnType<typeof deriveAbsenceLineItems>, type: string) =>
  result.lineItems.filter(li => li.item_type === type)

describe('återinsjuknande: only sick days count toward the fourteen (SjLL 7 §)', () => {
  // LB-11: månadslön 36 000, sick 5-14 October 2026 (Monday to Wednesday the
  // week after), back at work 15-16 October, sick again 19-23 October.
  const firstSpell = weekdays('2026-10-05', '2026-10-14')
  const secondSpell = weekdays('2026-10-19', '2026-10-23')

  it('backAtWorkBetween: a weekend is no working day, a weekday without a sick row is', () => {
    // Friday to Monday: only the weekend in between.
    expect(backAtWorkBetween('2026-10-09', '2026-10-12')).toBe(false)
    // Wednesday to Monday: Thursday and Friday were working days.
    expect(backAtWorkBetween('2026-10-14', '2026-10-19')).toBe(true)
    // Consecutive days never hold a day in between.
    expect(backAtWorkBetween('2026-10-05', '2026-10-06')).toBe(false)
    // Easter 2026: Thursday 2 April to Tuesday 7 April holds only Långfredag,
    // the weekend and Annandag påsk, so the illness never stopped.
    expect(backAtWorkBetween('2026-04-02', '2026-04-07')).toBe(false)
    // A one-day-a-week schedule has no weekdays on record: 7 days apart can
    // be two consecutive working days, 8 cannot.
    expect(backAtWorkBetween('2026-09-02', '2026-09-09', 1)).toBe(false)
    expect(backAtWorkBetween('2026-09-02', '2026-09-10', 1)).toBe(true)
    // Four days a week: consecutive working days are at most 4 apart.
    expect(backAtWorkBetween('2026-10-15', '2026-10-19', 4)).toBe(false)
    expect(backAtWorkBetween('2026-10-15', '2026-10-20', 4)).toBe(true)
  })

  it('splits one sjuklöneperiod into two spells and numbers the second from where the first left off', () => {
    const [seg, ...rest] = buildSjukloneperioder([...firstSpell, ...secondSpell])
    expect(rest).toEqual([])
    expect(seg.spells).toEqual([
      { startDate: '2026-10-05', endDate: '2026-10-14' },
      { startDate: '2026-10-19', endDate: '2026-10-23' },
    ])
    // The weekend inside the first spell counts: 12 October is day 8.
    expect(sjukloneperiodDayIndex(seg, '2026-10-12')).toBe(8)
    expect(sjukloneperiodDayIndex(seg, '2026-10-14')).toBe(10)
    // The healthy 15-18 October do not: 19 October is day 11, 23 October day 15.
    expect(sjukloneperiodDayIndex(seg, '2026-10-19')).toBe(11)
    expect(sjukloneperiodDayIndex(seg, '2026-10-22')).toBe(14)
    expect(sjukloneperiodDayIndex(seg, '2026-10-23')).toBe(15)
  })

  it('LB-11: pays 80 % sjuklön on 19-22 October and leaves only 23 October to Försäkringskassan, with one karensavdrag', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ monthlySalary: 36000, periodDays: sickRows([...firstSpell, ...secondSpell]) }),
    )
    const karens = rowOf(result, 'sick_karens')
    expect(karens).toHaveLength(1)
    expect(karens[0].description).toBe('Karensavdrag (2026-10-05)')
    expect(karens[0].amount).toBe(-1329.23)
    // 8 + 4 sick weekdays in days 1-14: 12 × (1 714,29 − 80 %).
    const sjuklon = rowOf(result, 'sick_day2_14')[0]
    expect(sjuklon.quantity).toBe(12)
    expect(sjuklon.amount).toBe(-4114.3)
    const fk = rowOf(result, 'sick_day15_plus')[0]
    expect(fk.quantity).toBe(1)
    expect(fk.amount).toBe(-1714.29)
    expect(result.flagFkReporting).toBe(true)
    // Gross on the payslip: 36 000 less the three rows.
    const gross = 36000 + result.lineItems.reduce((sum, li) => sum + li.amount, 0)
    expect(roundOre(gross)).toBe(28842.18)
  })

  it('a weekend between two sick weekdays of one illness still counts, as before', () => {
    // Sick every weekday 5-19 October: the weekends are sick days 6-7 and
    // 13-14, so 19 October is day 15.
    const dates = weekdays('2026-10-05', '2026-10-19')
    const [seg] = buildSjukloneperioder(dates)
    expect(seg.spells).toEqual([{ startDate: '2026-10-05', endDate: '2026-10-19' }])
    const result = deriveAbsenceLineItems(baseInput({ monthlySalary: 36000, periodDays: sickRows(dates) }))
    expect(rowOf(result, 'sick_day2_14')[0].quantity).toBe(10)
    expect(rowOf(result, 'sick_day15_plus')[0].quantity).toBe(1)
    expect(rowOf(result, 'sick_karens')).toHaveLength(1)
  })

  it('a public holiday without a sick row inside one illness is no return to work', () => {
    // Thursday 2 April, then Tuesday 7 April after Easter: one spell, 7 April is day 6.
    const [seg] = buildSjukloneperioder(['2026-04-02', '2026-04-07'])
    expect(seg.spells).toEqual([{ startDate: '2026-04-02', endDate: '2026-04-07' }])
    expect(sjukloneperiodDayIndex(seg, '2026-04-07')).toBe(6)
  })

  it('a gap longer than five days is a new sjuklöneperiod with a new karensavdrag, as before', () => {
    // Sick Monday to Wednesday 5-7 October, back, sick again Wednesday 14 October (7 days later).
    const result = deriveAbsenceLineItems(
      baseInput({ monthlySalary: 36000, periodDays: sickRows(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-14']) }),
    )
    expect(rowOf(result, 'sick_karens').map(k => k.description)).toEqual([
      'Karensavdrag (2026-10-05)',
      'Karensavdrag (2026-10-14)',
    ])
    expect(rowOf(result, 'sick_day2_14')[0].quantity).toBe(4)
    expect(rowOf(result, 'sick_day15_plus')).toHaveLength(0)
  })

  it('continues a spell of the previous month with only the days it left, and no new karensavdrag', () => {
    // Lookback: sick Monday 21 to Wednesday 30 September (10 calendar days,
    // karensavdrag taken then). Back 1-2 October. Sick again 5-9 October.
    const lookback = weekdays('2026-09-21', '2026-09-30')
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 36000,
        lookbackSickDates: lookback,
        lookbackSickDays: sickRows(lookback),
        periodDays: sickRows(weekdays('2026-10-05', '2026-10-09')),
      }),
    )
    expect(rowOf(result, 'sick_karens')).toHaveLength(0)
    // 5-8 October are days 11-14; 9 October is day 15.
    expect(rowOf(result, 'sick_day2_14')[0].quantity).toBe(4)
    expect(rowOf(result, 'sick_day15_plus')[0].quantity).toBe(1)
  })

  it('a two-spell sjuklöneperiod is one period for allmänt högriskskydd, as before', () => {
    // Nine single-day sjuklöneperioder earlier in the twelve months: LB-11 is
    // the tenth (karensavdrag) and a new illness on 30 October the eleventh (none).
    const lookback = ['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09', '2026-07-14', '2026-08-11', '2026-09-08']
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 36000,
        lookbackSickDates: lookback,
        periodDays: sickRows([...firstSpell, ...secondSpell, '2026-10-30']),
      }),
    )
    expect(rowOf(result, 'sick_karens').map(k => k.description)).toEqual(['Karensavdrag (2026-10-05)'])
  })

  it('on a four-day week, a gap wider than two consecutive working days ends the spell', () => {
    // Monday to Thursday. Sick 5-15 October (11 calendar days), back
    // Monday 19 October, sick again Tuesday 20 to Thursday 22 and Monday 26.
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-26']
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 36000,
        periodDays: sickRows(dates, 8),
        hoursPerDay: 8,
        hoursPerWeek: 32,
        workdaysPerWeek: 4,
        dailyDivisor: 17.33,
      }),
    )
    // 20-22 October are days 12-14; Monday 26 October (same spell: Thursday
    // to Monday is the schedule's own gap) is day 18.
    expect(rowOf(result, 'sick_day2_14')[0].quantity).toBe(11)
    expect(rowOf(result, 'sick_day15_plus')[0].quantity).toBe(1)
    expect(rowOf(result, 'sick_karens')).toHaveLength(1)
  })

  it('on a two-day week, where no gap inside a sjuklöneperiod can prove a working day, counts calendar days as before', () => {
    // Tuesday 6 and Monday 12 October, 6 days apart: one spell, 12 October is day 7.
    const [seg] = buildSjukloneperioder(['2026-10-06', '2026-10-12'], 2)
    expect(seg.spells).toHaveLength(1)
    expect(sjukloneperiodDayIndex(seg, '2026-10-12')).toBe(7)
  })

  it('a part-time employee on a five-day week is numbered the same way, by date', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        monthlySalary: 18000,
        periodDays: sickRows([...firstSpell, ...secondSpell], 4),
        hoursPerDay: 4,
        hoursPerWeek: 20,
        workdaysPerWeek: 5,
      }),
    )
    expect(rowOf(result, 'sick_day2_14')[0].quantity).toBe(12)
    expect(rowOf(result, 'sick_day15_plus')[0].quantity).toBe(1)
  })
})
