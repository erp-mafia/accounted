import { describe, it, expect } from 'vitest'
import { calculateBolagsskatt, BOLAGSSKATT_RATE } from '../tax-provision/bolagsskatt-calculator'

describe('calculateBolagsskatt', () => {
  it('applies 20.6% to positive result and posts 8910/2512', () => {
    const result = calculateBolagsskatt({ resultBeforeTax: 500_000 })

    expect(result.amount).toBe(Math.round(500_000 * BOLAGSSKATT_RATE)) // 103000
    const debit = result.lines.find((l) => l.account_number === '8910')!
    const credit = result.lines.find((l) => l.account_number === '2512')!
    expect(debit.debit_amount).toBe(103_000)
    expect(credit.credit_amount).toBe(103_000)
  })

  it('returns a zero-amount proposal for loss year (no entry posted)', () => {
    const result = calculateBolagsskatt({ resultBeforeTax: -50_000 })

    expect(result.amount).toBe(0)
    expect(result.lines).toEqual([])
    expect(result.description).toContain('förlust')
  })

  it('adds non-deductible expenses to taxable result', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 100_000,
      manualAdjustments: { nonDeductibleExpenses: 50_000 },
    })

    // (100_000 + 50_000) × 0.206 = 30_900
    expect(result.amount).toBe(30_900)
  })

  it('subtracts non-taxable income from taxable result', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 100_000,
      manualAdjustments: { nonTaxableIncome: 40_000 },
    })

    // (100_000 - 40_000) × 0.206 = 12_360
    expect(result.amount).toBe(12_360)
  })

  it('deducts the prior-year deficit (INK2S 4.14 a) before applying the rate', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 500_000,
      manualAdjustments: { deficitCarryforward: 120_000 },
    })

    // 500 000 - 120 000 = 380 000 taxable, 20.6 % = 78 280
    expect(result.amount).toBe(Math.round(380_000 * BOLAGSSKATT_RATE))
    expect(result.computation).toMatchObject({
      deficitCarryforward: 120_000,
      taxableResult: 380_000,
    })
  })

  it('books no tax when the prior-year deficit exceeds the result, and leaves the rest to INK2', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 100_000,
      manualAdjustments: { deficitCarryforward: 150_000 },
    })

    expect(result.amount).toBe(0)
    expect(result.lines).toEqual([])
    expect(result.computation).toMatchObject({ taxableResult: -50_000, taxableResultClamped: 0 })
  })

  it('adds schablonintäkt on periodiseringsfond to taxable result', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 200_000,
      manualAdjustments: { schablonintaktPeriodiseringsfond: 3_000 },
    })

    // (200_000 + 3_000) × 0.206 = 41_818
    expect(result.amount).toBe(41_818)
  })

  it('combines the result with manual adjustments', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 750_000,
      manualAdjustments: { schablonintaktPeriodiseringsfond: 3_000 },
    })

    // (750_000 + 3_000) × 0.206 = 155_118
    expect(result.amount).toBe(155_118)
  })

  it('calculates Miles tax after both non-deductible account addbacks', () => {
    const result = calculateBolagsskatt({
      resultBeforeTax: 592_722.21,
      manualAdjustments: { nonDeductibleExpenses: 2_994 + 2_250 },
    })

    expect(result.computation?.taxableResultClamped).toBe(597_960)
    expect(result.amount).toBe(123_180)
  })

  it('rounds taxable result down to a whole 10 SEK before applying tax', () => {
    const result = calculateBolagsskatt({ resultBeforeTax: 100_999.99 })

    expect(result.computation?.taxableResultClamped).toBe(100_990)
    expect(result.amount).toBe(20_804)
  })
})
