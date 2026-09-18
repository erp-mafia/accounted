import { describe, it, expect } from 'vitest'
import {
  deriveAbsenceLineItems,
  buildSjukloneperioder,
  type AbsenceDay,
  type DeriveInput,
} from '../derive-absence-line-items'
import type { PayrollConfig } from '../payroll-config'
import { SalaryCalculationPolicySchema } from '../calculation-policy'

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
  it('keeps historical leave cutoffs explicit without discarding prior-month context', () => {
    const july = days(['27', '28', '29', '30', '31'].map(d => [`2037-07-${d}`, 'parental']))
    const august = days(['03', '04', '05', '06', '07'].map(d => [`2037-08-${d}`, 'parental']))
    const input = baseInput({ monthlySalary: 63000, periodStart: '2037-07-01', periodEnd: '2037-07-31',
      periodDays: july, contextDays: august,
      calculationPolicy: SalaryCalculationPolicySchema.parse({ long_leave: 'calendar_after_five_workdays' }) })
    expect(deriveAbsenceLineItems(input).lineItems[0].amount).toBe(-10356.15)
    expect(deriveAbsenceLineItems({ ...input, calculationPolicy: SalaryCalculationPolicySchema.parse({
      long_leave: 'calendar_after_five_workdays', leave_context: 'through_deviation_end',
    }) }).lineItems[0].amount).toBe(-15000)
    const june = days(['22', '23', '24', '25', '26', '29', '30'].map(d => [`2037-06-${d}`, 'parental']))
    const earlyJuly = days(['01', '02', '03'].map(d => [`2037-07-${d}`, 'parental']))
    expect(deriveAbsenceLineItems({ ...input, periodDays: earlyJuly, contextDays: june,
      calculationPolicy: SalaryCalculationPolicySchema.parse({ long_leave: 'calendar_after_five_workdays', leave_context: 'through_deviation_end' }),
    }).lineItems[0].amount).toBe(-6213.69)
  })

  it('keeps documented partial illness continuous through vacation and changing extent', () => {
    const lookback = Array.from({ length: 30 }, (_, i) => `2037-06-${String(i + 1).padStart(2, '0')}`)
    const periodDays: AbsenceDay[] = Array.from({ length: 31 }, (_, i) => ({
      absence_date: `2037-07-${String(i + 1).padStart(2, '0')}`, absence_type: 'sick', hours: i < 4 ? 6 : 1,
    }))
    const result = deriveAbsenceLineItems(baseInput({ monthlySalary: 48000, periodDays, lookbackSickDates: lookback,
      lookbackSickDays: lookback.map(date => ({ absence_date: date, absence_type: 'sick', hours: 6 })),
      periodStart: '2037-07-01', periodEnd: '2037-07-31',
      calculationPolicy: SalaryCalculationPolicySchema.parse({ long_leave: 'calendar_after_five_workdays' }),
    }))
    expect(result.lineItems.find(line => line.item_type === 'sick_day15_plus')?.amount).toBe(-10060.26)
    expect(result.lineItems.some(line => line.item_type === 'sick_karens')).toBe(false)
  })
  it('separates a long FK episode and a new employer-paid episode in one month', () => {
    const prior = Array.from({ length: 30 }, (_, i) => `2037-06-${String(i + 1).padStart(2, '0')}`)
      .filter(d => new Date(d).getUTCDay() % 6 !== 0)
    const result = deriveAbsenceLineItems(baseInput({ monthlySalary: 48000,
      periodStart: '2037-07-01', periodEnd: '2037-07-31',
      calculationPolicy: SalaryCalculationPolicySchema.parse({ long_leave: 'calendar_after_five_workdays', sick_rate: 'annual_hourly' }),
      lookbackSickDates: prior,
      lookbackSickDays: prior.map(absence_date => ({ absence_date, absence_type: 'sick', hours: 3 })),
      periodDays: [...['01', '02', '03', '06', '07', '08', '09', '10'], ...['27', '28', '29', '30', '31']]
        .map(d => ({ absence_date: `2037-07-${d}`, absence_type: 'sick', hours: 3 })),
    }))
    expect(result.lineItems.find(li => li.item_type === 'sick_day15_plus')!.amount).toBe(-5917.8)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.amount).toBe(-830.7)
    expect(result.lineItems.find(li => li.item_type === 'sick_karens')!.amount).toBe(-1772.31)
  })
  it.each(['vab', 'parental', 'unpaid_leave'] as const)('weights partial %s by hours, without changing reported date counts', (absence_type) => {
    const full = deriveAbsenceLineItems(baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type, hours: 8 }] }))
    const half = deriveAbsenceLineItems(baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type, hours: 4 }] }))
    expect(half.lineItems[0].quantity).toBe(.5)
    expect(half.lineItems[0].amount).toBeCloseTo(full.lineItems[0].amount / 2, 1)
    expect(half.aggregated).toEqual(full.aggregated)
  })

  it('caps first-day karens at sick pay, never deducting more than the lost hours', () => {
    const result = deriveAbsenceLineItems(baseInput({ periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 1 }] }))
    expect(result.lineItems.reduce((s, li) => s + li.amount, 0)).toBeCloseTo(-178.57, 2)
  })

  it('carries unconsumed karens across the month boundary', () => {
    const june = deriveAbsenceLineItems(baseInput({ periodDays: [{ absence_date: '2026-06-30', absence_type: 'sick', hours: 1 }] }))
    const july = deriveAbsenceLineItems(baseInput({
      periodDays: [{ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }],
      lookbackSickDates: ['2026-06-30'],
      lookbackSickDays: [{ absence_date: '2026-06-30', absence_type: 'sick', hours: 1 }],
    }))
    const karens = [...june.lineItems, ...july.lineItems].filter(li => li.item_type === 'sick_karens').reduce((s, li) => s + li.amount, 0)
    expect(karens).toBe(-1107.69)
  })

  it('rejects absence exceeding the known schedule rather than over-deducting', () => {
    expect(() => deriveAbsenceLineItems(baseInput({ hoursPerDay: 6.4,
      periodDays: [{ absence_date: '2026-07-01', absence_type: 'vab', hours: 8 }],
    }))).toThrow('arbetsschemat')
  })

  it('emits karensavdrag for a single sick day', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ periodDays: days([['2026-04-06', 'sick']]) }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')
    expect(karens).toBeDefined()
    expect(karens!.quantity).toBe(1)
    expect(karens!.amount).toBeLessThan(0)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')!.quantity).toBe(1)
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
    expect(day2_14!.quantity).toBe(5) // day one also receives sick pay
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
    const vab = result.lineItems.find(li => li.item_type === 'vab')
    expect(vab).toBeDefined()
    expect(vab!.quantity).toBe(2)
    expect(vab!.is_vacation_basis).toBe(true) // ≤120 days YTD
    expect(result.aggregated.vabDays).toBe(2)
  })

  it('marks VAB non-vacation-basis when YTD >= 120', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([['2026-04-10', 'vab']]),
        vabDaysYtd: 120,
      }),
    )
    const vab = result.lineItems.find(li => li.item_type === 'vab')
    expect(vab!.is_vacation_basis).toBe(false)
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
