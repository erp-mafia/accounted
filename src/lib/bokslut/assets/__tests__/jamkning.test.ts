import { describe, expect, it } from 'vitest'
import { assessJamkning, assessJamkningEligibility } from '../jamkning'

describe('assessJamkningEligibility', () => {
  it('counts the acquisition and disposal tax years for movable property', () => {
    expect(
      assessJamkningEligibility({
        acquisitionDate: '2023-11-30',
        disposalDate: '2026-01-02',
        category: 'equipment',
      }),
    ).toMatchObject({ totalYears: 5, elapsedYears: 3, remainingYears: 2 })
  })

  it('uses ten years and the higher threshold for real property', () => {
    expect(
      assessJamkningEligibility({
        acquisitionDate: '2023-01-01',
        disposalDate: '2026-12-31',
        basAssetAccount: '1110',
      }),
    ).toMatchObject({ totalYears: 10, remainingYears: 7, threshold: 100_000 })
  })
})

describe('assessJamkning', () => {
  it('calculates a positive adjustment from total original VAT', () => {
    const result = assessJamkning({
      acquisitionDate: '2023-01-01',
      disposalDate: '2025-06-30',
      category: 'equipment',
      originalInputVat: 100_000,
      originalDeductionPercent: 40,
      disposalType: 'sale',
      vatTreatment: 'standard_25',
      netProceeds: 1_000_000,
    })

    expect(result).toMatchObject({
      direction: 'increase',
      remainingYears: 3,
      amount: 36_000,
      capped: false,
    })
  })

  it('caps positive movable-property adjustment at 25 percent of net proceeds', () => {
    const result = assessJamkning({
      acquisitionDate: '2025-01-01',
      disposalDate: '2025-12-31',
      category: 'equipment',
      originalInputVat: 100_000,
      originalDeductionPercent: 0,
      disposalType: 'sale',
      vatTreatment: 'standard_25',
      netProceeds: 40_000,
    })

    expect(result).toMatchObject({ direction: 'increase', amount: 10_000, capped: true })
  })

  it('calculates a negative adjustment for an exempt sale', () => {
    const result = assessJamkning({
      acquisitionDate: '2024-01-01',
      disposalDate: '2026-01-01',
      category: 'machinery',
      originalInputVat: 75_000,
      originalDeductionPercent: 100,
      disposalType: 'sale',
      vatTreatment: 'exempt',
      netProceeds: 200_000,
    })

    expect(result).toMatchObject({ direction: 'decrease', remainingYears: 3, amount: 45_000 })
  })

  it('does not adjust below the investment-good threshold', () => {
    expect(
      assessJamkning({
        acquisitionDate: '2026-01-01',
        disposalDate: '2026-06-30',
        category: 'equipment',
        originalInputVat: 49_999,
        originalDeductionPercent: 100,
        disposalType: 'sale',
        vatTreatment: 'exempt',
      }),
    ).toMatchObject({ direction: 'none', amount: 0, reason: 'below_threshold' })
  })

  it('transfers the obligation in a qualifying business transfer', () => {
    expect(
      assessJamkning({
        acquisitionDate: '2026-01-01',
        disposalDate: '2026-06-30',
        category: 'equipment',
        originalInputVat: 50_000,
        originalDeductionPercent: 100,
        disposalType: 'business_transfer',
      }),
    ).toMatchObject({ direction: 'transferred', amount: 0, reason: 'transferred' })
  })

  it('does not adjust a scrapped asset', () => {
    expect(
      assessJamkning({
        acquisitionDate: '2026-01-01',
        disposalDate: '2026-06-30',
        category: 'equipment',
        originalInputVat: 50_000,
        originalDeductionPercent: 100,
        disposalType: 'scrap',
      }),
    ).toMatchObject({ direction: 'none', amount: 0, reason: 'scrap' })
  })
})
