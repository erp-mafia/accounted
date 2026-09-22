import { describe, it, expect } from 'vitest'
import { calculateTraktamente, calculateMileageAllowance } from '../traktamente'
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

describe('calculateTraktamente', () => {
  it('calculates full-day traktamente at 300 SEK', () => {
    const result = calculateTraktamente({
      tripType: 'full_day',
      days: 3,
      mealsProvided: 'none',
      consecutiveMonths: 0,
      config,
    })
    expect(result.taxFree).toBe(900) // 300 × 3
    expect(result.taxable).toBe(0)
  })

  it('calculates half-day at 150 SEK', () => {
    const result = calculateTraktamente({
      tripType: 'half_day',
      days: 2,
      mealsProvided: 'none',
      consecutiveMonths: 0,
      config,
    })
    expect(result.taxFree).toBe(300) // 150 × 2
  })

  it('applies tremånadersregeln: 70% after 3 months', () => {
    const result = calculateTraktamente({
      tripType: 'full_day',
      days: 1,
      mealsProvided: 'none',
      consecutiveMonths: 4,
      config,
    })
    expect(result.taxFree).toBe(Math.round(300 * 0.70 * 100) / 100) // 210
    // If employer pays full rate (300), excess is taxable
    expect(result.taxable).toBe(Math.round((300 - 210) * 100) / 100) // 90
  })

  it('applies tremånadersregeln: 50% after 2 years', () => {
    const result = calculateTraktamente({
      tripType: 'full_day',
      days: 1,
      mealsProvided: 'none',
      consecutiveMonths: 25,
      config,
    })
    expect(result.taxFree).toBe(150) // 300 × 50%
    expect(result.taxable).toBe(150) // 300 - 150
  })

  it('reduces for meals provided: lunch reduces by 35%', () => {
    const result = calculateTraktamente({
      tripType: 'full_day',
      days: 1,
      mealsProvided: 'lunch',
      consecutiveMonths: 0,
      config,
    })
    const mealReduction = Math.round(300 * 0.35 * 100) / 100
    expect(result.taxFree).toBe(Math.round((300 - mealReduction) * 100) / 100)
  })

  it('reduces for all meals: 85%', () => {
    const result = calculateTraktamente({
      tripType: 'full_day',
      days: 1,
      mealsProvided: 'all',
      consecutiveMonths: 0,
      config,
    })
    const mealReduction = Math.round(300 * 0.85 * 100) / 100
    expect(result.taxFree).toBe(Math.round((300 - mealReduction) * 100) / 100)
  })
})

describe('calculateMileageAllowance', () => {
  it('calculates own car at 25 SEK/mil', () => {
    const result = calculateMileageAllowance({
      mil: 10,
      vehicleType: 'own_car',
      paidPerMil: 25,
      config,
    })
    expect(result.taxFree).toBe(250) // 25 × 10
    expect(result.taxable).toBe(0)
  })

  it('calculates company car fossil at 12 SEK/mil', () => {
    const result = calculateMileageAllowance({
      mil: 10,
      vehicleType: 'company_car_fossil',
      paidPerMil: 12,
      config,
    })
    expect(result.taxFree).toBe(120)
    expect(result.taxable).toBe(0)
  })

  it('calculates company car electric at 9.50 SEK/mil', () => {
    const result = calculateMileageAllowance({
      mil: 10,
      vehicleType: 'company_car_electric',
      paidPerMil: 9.50,
      config,
    })
    expect(result.taxFree).toBe(95)
    expect(result.taxable).toBe(0)
  })

  it('marks excess as taxable when paid above tax-free rate', () => {
    const result = calculateMileageAllowance({
      mil: 10,
      vehicleType: 'own_car',
      paidPerMil: 30, // 5 above tax-free
      config,
    })
    expect(result.taxFree).toBe(250) // 25 × 10
    expect(result.taxable).toBe(50)  // (30-25) × 10
  })
})
