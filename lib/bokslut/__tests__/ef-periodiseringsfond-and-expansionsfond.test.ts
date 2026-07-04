import { describe, it, expect } from 'vitest'
import { proposeEfPfondAvsattning, proposeEfPfondAteforing } from '../enskild-firma/periodiseringsfond-ef'
import { calculateExpansionsfondChange } from '../enskild-firma/expansionsfond-calculator'

describe('EF periodiseringsfond: avsättning', () => {
  it('caps at 30 % of surplus (vs 25 % for AB)', () => {
    const r = proposeEfPfondAvsattning({ surplus: 100_000, fiscalYear: 2026, desiredAmount: 50_000 })
    expect(r).not.toBeNull()
    // max = 30 000, desired 50 000 → capped to 30 000
    expect(r!.amount).toBe(30_000)
    expect(r!.warnings[0]).toContain('30')
  })

  it('returns null on zero / negative surplus', () => {
    expect(proposeEfPfondAvsattning({ surplus: 0, fiscalYear: 2026 })).toBeNull()
    expect(proposeEfPfondAvsattning({ surplus: -1, fiscalYear: 2026 })).toBeNull()
  })
})

describe('EF periodiseringsfond: återföring', () => {
  it('forces full reversal of 6+ year old fonder', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2020, balance: 50_000 }],
      closingYear: 2026,
    })
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(50_000)
    expect(items[0].warnings[0]).toContain('6-årsgränsen')
  })

  it('caps optional returns to the booked balance', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2023, balance: 20_000 }],
      closingYear: 2026,
      returns: { 2023: 100_000 },
    })
    expect(items[0].amount).toBe(20_000)
  })
})

describe('Expansionsfond', () => {
  it('caps avsättning at 125.94 % of kapitalunderlag', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 0,
      desiredChange: 200_000, // would exceed 125 940 cap
    })
    expect(r).not.toBeNull()
    expect(r!.amount).toBe(125_940)
    expect(r!.warnings[0]).toContain('125,94')
  })

  it('limits återföring to existing balance', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 30_000,
      desiredChange: -50_000,
    })
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('expansionsfond_ateforing')
    expect(r!.amount).toBe(30_000)
  })

  it('returns null when desiredChange is 0', () => {
    expect(
      calculateExpansionsfondChange({ kapitalunderlag: 100_000, desiredChange: 0 }),
    ).toBeNull()
  })
})
