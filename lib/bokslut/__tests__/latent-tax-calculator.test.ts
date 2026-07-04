import { describe, it, expect } from 'vitest'
import {
  computeLatentTax,
  proposeLatentTaxChange,
  LATENT_TAX_DEFAULT_RATE,
  LATENT_TAX_LIABILITY_ACCOUNT,
  LATENT_TAX_EXPENSE_ACCOUNT,
} from '../tax-provision/latent-tax-calculator'

describe('computeLatentTax', () => {
  it('splits 100 000 reserves into 79 400 equity + 20 600 liability at default 20,6 %', () => {
    const split = computeLatentTax({ untaxedReserves: 100_000 })
    expect(split.liabilityPortion).toBe(20_600)
    expect(split.equityPortion).toBe(79_400)
    // Invariant: the two portions reconcile to the input.
    expect(split.equityPortion + split.liabilityPortion).toBeCloseTo(100_000, 2)
  })

  it('returns zero portions for zero reserves', () => {
    const split = computeLatentTax({ untaxedReserves: 0 })
    expect(split.equityPortion).toBe(0)
    expect(split.liabilityPortion).toBe(0)
  })

  it('preserves the sign for negative reserves (over-reversal edge case)', () => {
    // Unusual but the math should stay symmetric: e.g. when the
    // dispositions builder posts more återföring than the existing reserves.
    const split = computeLatentTax({ untaxedReserves: -50_000 })
    expect(split.liabilityPortion).toBe(-10_300)
    expect(split.equityPortion).toBe(-39_700)
    expect(split.equityPortion + split.liabilityPortion).toBeCloseTo(-50_000, 2)
  })

  it('accepts a custom tax rate (future flex for rate changes)', () => {
    // If bolagsskatt drops to e.g. 18 %, K3 split would follow.
    const split = computeLatentTax({ untaxedReserves: 100_000, taxRate: 0.18 })
    expect(split.liabilityPortion).toBe(18_000)
    expect(split.equityPortion).toBe(82_000)
  })

  it('rounds to öre on non-integer reserves', () => {
    // 12 345.67 × 0.206 = 2 543.20802 → öre rounding → 2 543.21
    // equity = 12 345.67 − 2 543.21 = 9 802.46
    const split = computeLatentTax({ untaxedReserves: 12_345.67 })
    expect(split.liabilityPortion).toBe(2_543.21)
    expect(split.equityPortion).toBe(9_802.46)
    expect(split.equityPortion + split.liabilityPortion).toBeCloseTo(12_345.67, 2)
  })

  it('exports the canonical 20.6 % rate constant', () => {
    expect(LATENT_TAX_DEFAULT_RATE).toBe(0.206)
  })
})

describe('proposeLatentTaxChange', () => {
  it('returns null when current already equals target (no change)', () => {
    expect(proposeLatentTaxChange(20_600, 20_600)).toBeNull()
  })

  it('returns null when delta is below 1 öre tolerance', () => {
    // Floating-point dust below 1 öre should not produce a verifikat.
    expect(proposeLatentTaxChange(20_600, 20_600.001)).toBeNull()
    expect(proposeLatentTaxChange(20_600.0049, 20_600)).toBeNull()
  })

  it('books an avsättning when liability grows: debit 8940 / credit 2240', () => {
    const lines = proposeLatentTaxChange(0, 20_600)
    expect(lines).not.toBeNull()
    expect(lines).toHaveLength(2)
    const debit = lines!.find((l) => l.account_number === LATENT_TAX_EXPENSE_ACCOUNT)!
    const credit = lines!.find((l) => l.account_number === LATENT_TAX_LIABILITY_ACCOUNT)!
    expect(debit.debit_amount).toBe(20_600)
    expect(debit.credit_amount).toBe(0)
    expect(credit.debit_amount).toBe(0)
    expect(credit.credit_amount).toBe(20_600)
  })

  it('books a återföring when liability shrinks: debit 2240 / credit 8940', () => {
    const lines = proposeLatentTaxChange(20_600, 15_000)
    expect(lines).not.toBeNull()
    expect(lines).toHaveLength(2)
    const debit = lines!.find((l) => l.account_number === LATENT_TAX_LIABILITY_ACCOUNT)!
    const credit = lines!.find((l) => l.account_number === LATENT_TAX_EXPENSE_ACCOUNT)!
    expect(debit.debit_amount).toBe(5_600)
    expect(credit.credit_amount).toBe(5_600)
  })

  it('produces a balanced verifikat (sum debit = sum credit)', () => {
    const lines = proposeLatentTaxChange(10_000, 18_000)
    expect(lines).not.toBeNull()
    const totalDebit = lines!.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = lines!.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
    expect(totalDebit).toBe(8_000)
  })
})
