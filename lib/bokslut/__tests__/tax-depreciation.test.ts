import { describe, expect, it } from 'vitest'
import {
  computeTaxDepreciation,
  fiscalPeriodMonths,
} from '../assets/tax-depreciation'

describe('computeTaxDepreciation', () => {
  it('calculates the pooled 30 percent main rule after additions and disposals', () => {
    const result = computeTaxDepreciation({
      method: 'rakenskapsenlig',
      selectedRule: 'huvudregel_30',
      openingTaxValue: 100_000,
      additions: 50_000,
      disposals: 20_000,
      periodMonths: 12,
      cohorts: [],
    })

    expect(result.basis).toBe(130_000)
    expect(result.maximumDeduction).toBe(39_000)
    expect(result.deduction).toBe(39_000)
    expect(result.closingTaxValue).toBe(91_000)
  })

  it('reduces only by net disposal proceeds and floors a negative basis at zero', () => {
    const result = computeTaxDepreciation({
      method: 'restvarde',
      openingTaxValue: 10_000,
      additions: 0,
      disposals: 12_500,
      periodMonths: 12,
      cohorts: [],
    })

    expect(result.basis).toBe(0)
    expect(result.excessDisposals).toBe(2_500)
    expect(result.deduction).toBe(0)
  })

  it('uses 80, 60, 40, 20 and 0 percent closing cohorts for the 20 percent rule', () => {
    const result = computeTaxDepreciation({
      method: 'rakenskapsenlig',
      selectedRule: 'kompletteringsregel_20',
      openingTaxValue: 400_000,
      additions: 100_000,
      disposals: 0,
      periodMonths: 12,
      cohorts: [12, 24, 36, 48, 60].map((elapsedMonths, index) => ({
        label: String(index),
        acquisitionCost: 100_000,
        elapsedMonths,
      })),
    })

    expect(result.cohorts.map((cohort) => cohort.closingValue)).toEqual([
      80_000,
      60_000,
      40_000,
      20_000,
      0,
    ])
    expect(result.closingTaxValue).toBe(200_000)
    expect(result.deduction).toBe(300_000)
  })

  it('lets the annual räkenskapsenlig election switch between 30 and 20 alternatives', () => {
    const shared = {
      method: 'rakenskapsenlig' as const,
      openingTaxValue: 70_000,
      additions: 100_000,
      disposals: 0,
      periodMonths: 12,
      cohorts: [{ label: '2025', acquisitionCost: 100_000, elapsedMonths: 12 }],
    }
    const main = computeTaxDepreciation({ ...shared, selectedRule: 'huvudregel_30' })
    const complement = computeTaxDepreciation({
      ...shared,
      selectedRule: 'kompletteringsregel_20',
    })

    expect(main.closingTaxValue).toBe(119_000)
    expect(complement.closingTaxValue).toBe(80_000)
    expect(main.alternatives).toEqual(complement.alternatives)
  })

  it('stores an elected deduction below the statutory maximum without changing the maximum', () => {
    const result = computeTaxDepreciation({
      method: 'rakenskapsenlig',
      selectedRule: 'huvudregel_30',
      openingTaxValue: 100_000,
      additions: 0,
      disposals: 0,
      periodMonths: 12,
      cohorts: [],
      electedDeduction: 20_000,
    })

    expect(result.maximumDeduction).toBe(30_000)
    expect(result.deduction).toBe(20_000)
    expect(result.closingTaxValue).toBe(80_000)
  })

  it('rejects an elected deduction above the statutory maximum', () => {
    expect(() => computeTaxDepreciation({
      method: 'restvarde',
      openingTaxValue: 100_000,
      additions: 0,
      disposals: 0,
      periodMonths: 12,
      cohorts: [],
      electedDeduction: 25_001,
    })).toThrow(/must not exceed the statutory maximum/)
  })

  it('adjusts 30 and 25 percent proportionally for short and long fiscal periods', () => {
    const short = computeTaxDepreciation({
      method: 'rakenskapsenlig',
      selectedRule: 'huvudregel_30',
      openingTaxValue: 100_000,
      additions: 0,
      disposals: 0,
      periodMonths: 6,
      cohorts: [],
    })
    const long = computeTaxDepreciation({
      method: 'restvarde',
      openingTaxValue: 100_000,
      additions: 0,
      disposals: 0,
      periodMonths: 18,
      cohorts: [],
    })

    expect(short.deduction).toBe(15_000)
    expect(long.deduction).toBe(37_500)
  })

  it('adjusts the 20 percent cohort rate for a short fiscal period', () => {
    const result = computeTaxDepreciation({
      method: 'rakenskapsenlig',
      selectedRule: 'kompletteringsregel_20',
      openingTaxValue: 0,
      additions: 100_000,
      disposals: 0,
      periodMonths: 6,
      cohorts: [{ label: 'short', acquisitionCost: 100_000, elapsedMonths: 6 }],
    })

    expect(result.closingTaxValue).toBe(90_000)
    expect(result.deduction).toBe(10_000)
  })

  it('rejects a 20 percent rule selection for rest value depreciation', () => {
    expect(() => computeTaxDepreciation({
      method: 'restvarde',
      selectedRule: 'kompletteringsregel_20',
      openingTaxValue: 100_000,
      additions: 0,
      disposals: 0,
      periodMonths: 12,
      cohorts: [],
    })).toThrow(/only valid for rakenskapsenlig/)
  })
})

describe('fiscalPeriodMonths', () => {
  it('counts calendar months inclusively for normal, short and long years', () => {
    expect(fiscalPeriodMonths('2025-01-01', '2025-12-31')).toBe(12)
    expect(fiscalPeriodMonths('2025-07-01', '2025-12-31')).toBe(6)
    expect(fiscalPeriodMonths('2024-07-01', '2025-12-31')).toBe(18)
  })
})
