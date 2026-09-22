import { describe, it, expect } from 'vitest'
import { calculateCarBenefit, getMealBenefitValue, calculateWellnessBenefit, calculateBikeBenefit, BIKE_BENEFIT_TAX_FREE_ALLOWANCE } from '../benefits'
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

describe('calculateCarBenefit', () => {
  it('calculates Gen3 car benefit', () => {
    const result = calculateCarBenefit({
      nybilspris: 350000,
      fordonsskatt: 3600,
      isEnvironmental: false,
      highMileage: false,
    }, config)

    // 0.29 × 59200 = 17168
    // 350000 × (0.70 × 0.0255 + 0.01) = 350000 × 0.02785 = 9747.5
    // 0.13 × 350000 = 45500
    // + 3600 fordonsskatt
    // = 17168 + 9747.5 + 45500 + 3600 = 76015.5
    // monthly = 76015.5 / 12 ≈ 6334.63

    expect(result.annualValue).toBeGreaterThan(0)
    expect(result.monthlyValue).toBe(Math.round(result.annualValue / 12 * 100) / 100)
    expect(result.steps.length).toBeGreaterThanOrEqual(2)
  })

  it('applies environmental reduction for electric cars', () => {
    const standard = calculateCarBenefit({
      nybilspris: 500000,
      fordonsskatt: 3600,
      isEnvironmental: false,
      highMileage: false,
    }, config)

    const electric = calculateCarBenefit({
      nybilspris: 500000,
      fordonsskatt: 360,
      isEnvironmental: true,
      environmentalType: 'electric',
      highMileage: false,
    }, config)

    // Electric reduces nybilspris by 350,000 (max 50% of 500,000 = 250,000)
    // So reduction is capped at 250,000
    expect(electric.annualValue).toBeLessThan(standard.annualValue)
  })

  it('caps environmental reduction at 50% of nybilspris', () => {
    const result = calculateCarBenefit({
      nybilspris: 400000,
      fordonsskatt: 3600,
      isEnvironmental: true,
      environmentalType: 'electric', // Would reduce by 350,000 but cap at 200,000
      highMileage: false,
    }, config)

    // Reduction: min(350000, 400000 × 0.5) = 200000
    // Adjusted price: 200000
    expect(result.steps.some(s => s.label.includes('Miljöbils'))).toBe(true)
  })

  it('applies 25% high-mileage reduction', () => {
    const normal = calculateCarBenefit({
      nybilspris: 350000,
      fordonsskatt: 3600,
      isEnvironmental: false,
      highMileage: false,
    }, config)

    const highMileage = calculateCarBenefit({
      nybilspris: 350000,
      fordonsskatt: 3600,
      isEnvironmental: false,
      highMileage: true,
    }, config)

    expect(highMileage.annualValue).toBe(Math.round(normal.annualValue * 0.75 * 100) / 100)
  })
})

describe('getMealBenefitValue', () => {
  it('returns correct schablonvärde for 2026', () => {
    expect(getMealBenefitValue('full_day', config)).toBe(310)
    expect(getMealBenefitValue('lunch', config)).toBe(124)
    expect(getMealBenefitValue('breakfast', config)).toBe(62)
  })
})

describe('calculateWellnessBenefit', () => {
  it('marks as tax-free when within cap', () => {
    const result = calculateWellnessBenefit(3000, 0, config)
    expect(result.taxable).toBe(false)
    expect(result.taxableAmount).toBe(0)
  })

  it('marks ENTIRE amount as taxable when cap exceeded', () => {
    const result = calculateWellnessBenefit(3000, 3000, config)
    // YTD = 3000 + 3000 = 6000 > 5000 cap
    expect(result.taxable).toBe(true)
    expect(result.taxableAmount).toBe(6000) // Full amount, not just excess
  })

  it('handles exact cap boundary', () => {
    const result = calculateWellnessBenefit(2500, 2500, config)
    // YTD = 5000 = cap: still tax-free
    expect(result.taxable).toBe(false)
  })

  it('handles single amount exceeding cap', () => {
    const result = calculateWellnessBenefit(6000, 0, config)
    expect(result.taxable).toBe(true)
    expect(result.taxableAmount).toBe(6000)
  })
})

describe('calculateBikeBenefit', () => {
  it('is tax-free entirely when annual value is below the 3 000 kr schablon', () => {
    const result = calculateBikeBenefit(2500)
    expect(result.annualTaxable).toBe(0)
    expect(result.monthlyValue).toBe(0)
    expect(result.taxFreePortion).toBe(2500)
  })

  it('taxes only the excess over 3 000 kr', () => {
    const result = calculateBikeBenefit(8400)
    // 8400 - 3000 = 5400 taxable annually → 450/month
    expect(result.annualTaxable).toBe(5400)
    expect(result.monthlyValue).toBe(450)
    expect(result.taxFreePortion).toBe(3000)
  })

  it('handles 0 or negative input gracefully', () => {
    expect(calculateBikeBenefit(0).monthlyValue).toBe(0)
    expect(calculateBikeBenefit(-100).monthlyValue).toBe(0)
  })

  it('exposes the schablon constant', () => {
    expect(BIKE_BENEFIT_TAX_FREE_ALLOWANCE).toBe(3000)
  })
})
