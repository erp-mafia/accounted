import { describe, it, expect } from 'vitest'
import { calculateSjuklon, calculateVabDeduction, calculateParentalLeaveDeduction, calculateVacationPay } from '../absence-calculator'
import type { PayrollConfig } from '../payroll-config'

const config: PayrollConfig = {
  configYear: 2026,
  avgifterTotal: 0.3142,
  avgifterAlderspension: 0.1021,
  avgifterSjukforsakring: 0.0355,
  avgifterForaldraforsakring: 0.0200,
  avgifterEfterlevandepension: 0.0030,
  avgifterArbetsmarknad: 0.0264,
  avgifterArbetsskada: 0.0010,
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
  milersattningFormansbilEl: 9.50,
  kostformanHeldag: 310,
  kostformanLunch: 124,
  kostformanFrukost: 62,
  friskvardCap: 5000,
  bilformanSlr: 0.0255,
  sjuklonRate: 0.80,
  karensavdragFactor: 0.20,
  maxKarensavdragPerYear: 10,
  reducedAvgiftAge: 67,
}

const r = (x: number) => Math.round(x * 100) / 100

describe('calculateSjuklon', () => {
  it('calculates karensavdrag correctly (20% of weekly sjuklön)', () => {
    const result = calculateSjuklon(30000, 1, config)
    // weekly = 30000 × 12/52 × 0.80 = 5538.46
    // karens = 5538.46 × 0.20 = 1107.69
    const expectedWeekly = r(30000 * 12 / 52 * 0.80)
    const expectedKarens = r(expectedWeekly * 0.20)
    expect(result.karensavdrag).toBe(expectedKarens)
  })

  it('calculates sjuklön day 2-14 at 80%', () => {
    const result = calculateSjuklon(30000, 5, config)
    const dailyRate = r(30000 / 21)
    // 4 sjuklön days (day 2-5)
    const expectedSjuklon = r(dailyRate * 0.80 * 4)
    expect(result.sjuklonDays).toBe(4)
    expect(result.sjuklonAmount).toBe(expectedSjuklon)
  })

  it('caps sjuklön days at 13 (day 2-14)', () => {
    const result = calculateSjuklon(30000, 20, config)
    expect(result.sjuklonDays).toBe(13)
  })

  it('handles 1-day sickness (karens only, no sjuklön)', () => {
    const result = calculateSjuklon(30000, 1, config)
    expect(result.sjuklonDays).toBe(0)
    expect(result.sjuklonAmount).toBe(0)
    expect(result.karensavdrag).toBeGreaterThan(0)
  })

  it('skips karensavdrag for återinsjuknande (within 5 days)', () => {
    const result = calculateSjuklon(30000, 3, config, true)
    expect(result.karensavdrag).toBe(0)
    // Sjuklön from day 1 since no karensavdrag
    expect(result.sjuklonDays).toBe(3)
  })

  it('returns calculation steps for transparency', () => {
    const result = calculateSjuklon(30000, 5, config)
    expect(result.steps.length).toBeGreaterThanOrEqual(4)
    expect(result.steps.some(s => s.label === 'Karensavdrag')).toBe(true)
    expect(result.steps.some(s => s.label === 'Sjuklön dag 2-14')).toBe(true)
  })

  it('calculates total deduction correctly', () => {
    const result = calculateSjuklon(30000, 5, config)
    const dailyRate = r(30000 / 21)
    const normalPay = r(dailyRate * 5)
    // totalDeduction = normalPay - sjuklön + karens
    expect(result.totalDeduction).toBe(r(normalPay - result.sjuklonAmount + result.karensavdrag))
  })
})

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

describe('calculateVacationPay', () => {
  it('calculates sammalöneregeln tillägg', () => {
    const result = calculateVacationPay({
      monthlySalary: 40000,
      vacationDaysTaken: 5,
      vacationRule: 'sammaloneregeln',
      semestertillaggRate: 0.0043,
      vacationDaysPerYear: 25,
    })
    const expectedTillagg = r(40000 * 0.0043 * 5)
    expect(result.tillagg).toBe(expectedTillagg)
    expect(result.amount).toBe(expectedTillagg)
  })

  it('uses 0.8% CBA rate when specified', () => {
    const result = calculateVacationPay({
      monthlySalary: 40000,
      vacationDaysTaken: 5,
      vacationRule: 'sammaloneregeln',
      semestertillaggRate: 0.008,
      vacationDaysPerYear: 25,
    })
    const expectedTillagg = r(40000 * 0.008 * 5)
    expect(result.tillagg).toBe(expectedTillagg)
  })

  it('calculates procentregeln at 12%', () => {
    const result = calculateVacationPay({
      monthlySalary: 30000,
      vacationDaysTaken: 5,
      vacationRule: 'procentregeln',
      semestertillaggRate: 0.0043,
      vacationDaysPerYear: 25,
    })
    const annualBasis = r(30000 * 12)
    const totalVacPay = r(annualBasis * 0.12)
    const perDay = r(totalVacPay / 25)
    expect(result.amount).toBe(r(perDay * 5))
  })

  it('uses the kollektivavtal rate (13.5%) under procentregeln when set', () => {
    const result = calculateVacationPay({
      monthlySalary: 30000,
      vacationDaysTaken: 5,
      vacationRule: 'procentregeln',
      semestertillaggRate: 0.0043,
      vacationDaysPerYear: 25,
      vacationPayRate: 0.135,
    })
    const annualBasis = r(30000 * 12)
    const totalVacPay = r(annualBasis * 0.135)
    const perDay = r(totalVacPay / 25)
    expect(result.amount).toBe(r(perDay * 5))
    expect(result.steps[0].label).toBe('Semesterlön (procentregeln 13.5%)')
    expect(result.steps[0].input.rate).toBe(0.135)
  })

  it('sammalöneregeln ignores the kollektivavtal rate', () => {
    const base = {
      monthlySalary: 30000,
      vacationDaysTaken: 5,
      vacationRule: 'sammaloneregeln' as const,
      semestertillaggRate: 0.0043,
      vacationDaysPerYear: 25,
    }
    expect(calculateVacationPay({ ...base, vacationPayRate: 0.135 }).amount).toBe(
      calculateVacationPay(base).amount,
    )
  })

  it('uses 14.4% for 30+ vacation days', () => {
    const result = calculateVacationPay({
      monthlySalary: 30000,
      vacationDaysTaken: 5,
      vacationRule: 'procentregeln',
      semestertillaggRate: 0.0043,
      vacationDaysPerYear: 30,
    })
    const annualBasis = r(30000 * 12)
    const totalVacPay = r(annualBasis * 0.144)
    const perDay = r(totalVacPay / 30)
    expect(result.amount).toBe(r(perDay * 5))
  })
})
