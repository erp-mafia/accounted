import { describe, it, expect } from 'vitest'
import { proposeOveravskrivningar } from '../reserves/overavskrivningar-service'
import { computeTaxDepreciation, type TaxDepreciationInput } from '../assets/tax-depreciation'

// The 30- and 20-rule had a second implementation here (compute30Rule,
// compute20Rule, pickLowerResidual) beside computeTaxDepreciation. The
// överavskrivningar calculator now uses computeTaxDepreciation; these are the
// old copy's assertions, kept against the one implementation.
function closing(input: Omit<TaxDepreciationInput, 'method' | 'selectedRule' | 'cohorts'> & Partial<Pick<TaxDepreciationInput, 'cohorts'>>) {
  const result = computeTaxDepreciation({ method: 'rakenskapsenlig', selectedRule: 'huvudregel_30', cohorts: [], ...input })
  const of = (rule: string) => result.alternatives.find((a) => a.rule === rule)!.closingTaxValue
  return { basis: result.basis, rule30: of('huvudregel_30'), rule20: of('kompletteringsregel_20') }
}

describe('30-regeln (IL 18 kap. 14 §), via computeTaxDepreciation', () => {
  it('leaves 70 % of opening value + additions - disposals', () => {
    const result = closing({ openingTaxValue: 100_000, additions: 50_000, disposals: 20_000, periodMonths: 12 })
    expect(result.basis).toBe(130_000)
    expect(result.rule30).toBe(91_000)
  })

  it('pro-rates the 30 % rate for a six-month period', () => {
    expect(closing({ openingTaxValue: 100_000, additions: 0, disposals: 0, periodMonths: 6 }).rule30).toBe(85_000)
  })

  it('never produces a negative basis when proceeds exceed it', () => {
    const result = closing({ openingTaxValue: 10_000, additions: 0, disposals: 20_000, periodMonths: 12 })
    expect(result.basis).toBe(0)
    expect(result.rule30).toBe(0)
  })
})

describe('20-regeln (IL 18 kap. 17 §), via computeTaxDepreciation', () => {
  const cohort = (acquisitionCost: number, elapsedMonths: number) => ({ label: `c${elapsedMonths}`, acquisitionCost, elapsedMonths })

  it('residual = cost × (5 - age) / 5 per cohort, the acquisition period included', () => {
    const result = closing({
      openingTaxValue: 400_000,
      additions: 100_000,
      disposals: 0,
      periodMonths: 12,
      cohorts: [cohort(100_000, 12), cohort(100_000, 24), cohort(100_000, 36), cohort(100_000, 48), cohort(100_000, 60)],
    })
    // 80 + 60 + 40 + 20 + 0
    expect(result.rule20).toBe(200_000)
  })

  it('pro-rates shortened fiscal periods', () => {
    const result = closing({
      openingTaxValue: 100_000,
      additions: 100_000,
      disposals: 0,
      periodMonths: 6,
      // Current cohort: 6 months (10 %). Prior: 6 + 12 months (30 %).
      cohorts: [cohort(100_000, 6), cohort(100_000, 18)],
    })
    expect(result.rule20).toBe(160_000)
  })
})

describe('proposeOveravskrivningar', () => {
  it('emits balanced 8853 / 2153 entry for positive amount', () => {
    const result = proposeOveravskrivningar({ additionalAmount: 25_000 })
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(25_000)
    expect(result!.lines[0].account_number).toBe('8853')
    expect(result!.lines[0].debit_amount).toBe(25_000)
    expect(result!.lines[1].account_number).toBe('2153')
    expect(result!.lines[1].credit_amount).toBe(25_000)
    expect(result!.signedAmount).toBe(25_000)
    expect(result!.warnings).toHaveLength(0)
  })

  it('emits reversal entry for negative amount with warning', () => {
    const result = proposeOveravskrivningar({ additionalAmount: -10_000 })
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(10_000)
    expect(result!.lines[0].account_number).toBe('2153')
    expect(result!.lines[0].debit_amount).toBe(10_000)
    expect(result!.lines[1].account_number).toBe('8853')
    expect(result!.lines[1].credit_amount).toBe(10_000)
    expect(result!.signedAmount).toBe(-10_000)
    expect(result!.required).toBe(true)
    expect(result!.warnings).toHaveLength(1)
  })

  it('returns null for zero amount', () => {
    expect(proposeOveravskrivningar({ additionalAmount: 0 })).toBeNull()
  })

  it('rounds fractional input to öre', () => {
    const result = proposeOveravskrivningar({ additionalAmount: 1234.567 })
    expect(result!.amount).toBe(1_234.57)
    expect(result!.lines[0].debit_amount).toBe(1_234.57)
    expect(result!.lines[1].credit_amount).toBe(1_234.57)
  })

  it('uses building accounts 8852/2152 when category=building', () => {
    const result = proposeOveravskrivningar({
      additionalAmount: 50_000,
      category: 'building',
    })
    expect(result!.lines[0].account_number).toBe('8852')
    expect(result!.lines[1].account_number).toBe('2152')
    expect(result!.label).toContain('byggnader')
  })

  it('uses immaterial accounts 8851/2151 when category=immaterial', () => {
    const result = proposeOveravskrivningar({
      additionalAmount: 30_000,
      category: 'immaterial',
    })
    expect(result!.lines[0].account_number).toBe('8851')
    expect(result!.lines[1].account_number).toBe('2151')
    expect(result!.label).toContain('immateriella')
  })

  it('defaults to maskiner & inventarier (8853/2153) when no category given', () => {
    const result = proposeOveravskrivningar({ additionalAmount: 20_000 })
    expect(result!.lines[0].account_number).toBe('8853')
    expect(result!.lines[1].account_number).toBe('2153')
  })
})
