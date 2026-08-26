import { describe, it, expect } from 'vitest'
import {
  compute30Rule,
  compute20Rule,
  compute20RuleForFiscalPeriods,
  pickLowerResidual,
  proposeOveravskrivningar,
  OVERAVSKRIVNING_30_RULE,
} from '../reserves/overavskrivningar-service'

describe('compute30Rule', () => {
  it('returns minimum residual = 70% of base', () => {
    const result = compute30Rule({
      openingBookValue: 100_000,
      additions: 50_000,
      disposals: 20_000,
    })
    // base = 100 + 50 - 20 = 130_000, residual = 91_000, maxAllowed = 39_000
    expect(result.base).toBe(130_000)
    expect(result.minimumResidual).toBe(91_000)
    expect(result.maxAllowedAccumulated).toBe(39_000)
  })

  it('uses 0.7 rate per constant', () => {
    expect(OVERAVSKRIVNING_30_RULE).toBe(0.7)
  })
})

describe('compute20Rule', () => {
  it('residual = sum of cost × (5 − age) / 5 per cohort', () => {
    const result = compute20Rule({
      // current year, year-1, year-2, year-3, year-4
      acquisitionCostByYearOffset: [100_000, 100_000, 100_000, 100_000, 100_000],
    })
    // The acquisition period gets the first 20% deduction. Residuals are
    // therefore 80 + 60 + 40 + 20 + 0 = 200.
    expect(result.minimumResidual).toBe(200_000)
  })

  it('skips cohorts where no acquisitions happened', () => {
    const result = compute20Rule({
      acquisitionCostByYearOffset: [50_000, 0, 0, 0, 0],
    })
    expect(result.minimumResidual).toBe(40_000)
  })

  it('pro-rates shortened fiscal periods', () => {
    const result = compute20RuleForFiscalPeriods({
      acquisitionCostByPeriod: [100_000, 100_000],
      fiscalPeriodMonths: [6, 12],
    })
    // Current cohort: 10% deducted. Prior cohort: 30% cumulative.
    expect(result.minimumResidual).toBe(160_000)
  })
})

describe('compute30Rule: fiscal period length', () => {
  it('pro-rates the 30% rate for a six-month period', () => {
    const result = compute30Rule({
      openingBookValue: 100_000,
      additions: 0,
      disposals: 0,
      fiscalPeriodMonths: 6,
    })
    expect(result.minimumResidual).toBe(85_000)
    expect(result.maxAllowedAccumulated).toBe(15_000)
  })

  it('never produces a negative tax base when proceeds exceed the basis', () => {
    const result = compute30Rule({
      openingBookValue: 10_000,
      additions: 0,
      disposals: 20_000,
    })
    expect(result.base).toBe(0)
    expect(result.minimumResidual).toBe(0)
  })
})

describe('pickLowerResidual', () => {
  it('returns whichever rule yields the lower residual (= more deduction)', () => {
    const r30 = { base: 100_000, minimumResidual: 70_000, maxAllowedAccumulated: 30_000 }
    const r20 = { minimumResidual: 60_000 }
    const pick = pickLowerResidual(r30, r20)
    expect(pick.residual).toBe(60_000)
    expect(pick.rule).toBe('20-regeln')
  })

  it('prefers 30-rule on tie (default behaviour)', () => {
    const r30 = { base: 100_000, minimumResidual: 70_000, maxAllowedAccumulated: 30_000 }
    const r20 = { minimumResidual: 70_000 }
    const pick = pickLowerResidual(r30, r20)
    expect(pick.rule).toBe('30-regeln')
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
