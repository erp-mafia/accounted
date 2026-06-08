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

describe('deriveAbsenceLineItems — sick', () => {
  it('emits karensavdrag for a single sick day', () => {
    const result = deriveAbsenceLineItems(
      baseInput({ periodDays: days([['2026-04-06', 'sick']]) }),
    )
    const karens = result.lineItems.find(li => li.item_type === 'sick_karens')
    expect(karens).toBeDefined()
    expect(karens!.quantity).toBe(1)
    expect(karens!.amount).toBeLessThan(0)
    expect(result.lineItems.find(li => li.item_type === 'sick_day2_14')).toBeUndefined()
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
    expect(day2_14!.quantity).toBe(4) // days 2-5 of segment
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

describe('deriveAbsenceLineItems — VAB', () => {
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

describe('deriveAbsenceLineItems — parental', () => {
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

describe('deriveAbsenceLineItems — unpaid_leave', () => {
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
    // false — engine's Step 3 absence sum already subtracts unpaid_leave;
    // setting the flag would double-count in Step 4 totalGrossDeductions.
    expect(unpaid!.is_gross_deduction).toBe(false)
    expect(unpaid!.is_vacation_basis).toBe(false)
    expect(result.aggregated.unpaidLeaveDays).toBe(2)
  })
})

describe('deriveAbsenceLineItems — empty', () => {
  it('returns empty result for no absence', () => {
    const result = deriveAbsenceLineItems(baseInput())
    expect(result.lineItems).toEqual([])
    expect(result.aggregated).toEqual({ sickDays: 0, vabDays: 0, parentalDays: 0, unpaidLeaveDays: 0 })
    expect(result.flagFkReporting).toBe(false)
    expect(result.flagLakarintyg).toBe(false)
  })
})
