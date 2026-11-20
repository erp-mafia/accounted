import { describe, it, expect } from 'vitest'
import { calculateBikeBenefit, BIKE_BENEFIT_TAX_FREE_ALLOWANCE } from '../benefits'

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
