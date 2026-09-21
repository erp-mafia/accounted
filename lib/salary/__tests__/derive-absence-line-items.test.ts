import { describe, it, expect } from 'vitest'
import {
  deriveAbsenceLineItems,
  buildSjukloneperioder,
  type AbsenceDay,
  type DeriveInput,
} from '../derive-absence-line-items'
import type { PayrollConfig } from '../payroll-config'

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
    expect(vab[0]).toMatchObject({ quantity: 0.5, is_vacation_basis: true, description: 'VAB (1 dagar)' })
    expect(vab[1]).toMatchObject({
      quantity: 0.5,
      is_vacation_basis: false,
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
    expect(vab[0].is_vacation_basis).toBe(true) // ≤120 days YTD
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
    expect(vab[0].is_vacation_basis).toBe(false)
    expect(vab[0].quantity).toBe(1)
    expect(vab[0].description).toBe('VAB (1 dagar, ej semestergrundande)')
  })
})

// SemL 17 § (VAB) and 17 a § (parental leave): 120 calendar dates. The same
// split rule serves both; the table carries what differs.
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
      is_vacation_basis: true,
      is_gross_deduction: true,
    })
    expect(rows[1]).toEqual({
      item_type,
      description: `${label} (1 dagar, ej semestergrundande)`,
      quantity: 1,
      amount: -1428.57,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
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
    expect(rows[0].is_vacation_basis).toBe(true)
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
    expect(rows[0].is_vacation_basis).toBe(false)
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
    expect(rows[0]).toMatchObject({ quantity: 0.5, is_vacation_basis: true })
    expect(rows[1]).toMatchObject({ quantity: 1, is_vacation_basis: false })
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
    expect(unpaid!.is_vacation_basis).toBe(false)
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
    expect(parental[0].is_vacation_basis).toBe(true)
    expect(parental[0].amount).toBe(-1972.6)
    expect(parental[1].is_vacation_basis).toBe(false)
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
