import { describe, it, expect } from 'vitest'
import {
  AMOUNT_BLOCK_MULTIPLIER,
  amountBlockLimit,
  computeLossYear,
  defaultGroupBlockLastYear,
  type LossYearInput,
} from '../calculator'

const base: LossYearInput = {
  broughtForward: 0,
  resultBeforeDeficit: null,
  groupContributionsReceived: 0,
  amountBlock: null,
  groupBlock: null,
}

describe('computeLossYear: no spärr (IL 40 kap. 2 §)', () => {
  it('carries a deficit year forward in full', () => {
    const r = computeLossYear({ ...base, resultBeforeDeficit: -120_000 })
    expect(r).toMatchObject({ deductible: 0, taxableResult: -120_000, carriedForward: 120_000, warnings: [] })
  })

  it('deducts the whole deficit brought forward and carries what the result cannot absorb', () => {
    const r = computeLossYear({ ...base, broughtForward: 200_000, resultBeforeDeficit: 150_000 })
    expect(r).toMatchObject({ deductible: 200_000, taxableResult: -50_000, carriedForward: 50_000 })
  })

  it('uses up a deficit smaller than the överskott', () => {
    const r = computeLossYear({ ...base, broughtForward: 80_000, resultBeforeDeficit: 150_000 })
    expect(r).toMatchObject({ deductible: 80_000, taxableResult: 70_000, carriedForward: 0 })
  })

  it('adds a new deficit on top of the one brought forward', () => {
    const r = computeLossYear({ ...base, broughtForward: 80_000, resultBeforeDeficit: -20_000 })
    expect(r).toMatchObject({ taxableResult: -100_000, carriedForward: 100_000 })
  })

  it('keeps öre exact', () => {
    const r = computeLossYear({ ...base, broughtForward: 1000.1, resultBeforeDeficit: 500.05 })
    expect(r.taxableResult).toBe(-500.05)
    expect(r.carriedForward).toBe(500.05)
  })

  it('leaves the outcome open while the year\'s result is unknown, but still knows the deduction', () => {
    const r = computeLossYear({ ...base, broughtForward: 75_000 })
    expect(r).toMatchObject({ deductible: 75_000, taxableResult: null, carriedForward: null, warnings: [] })
  })
})

describe('computeLossYear: beloppsspärr (IL 40 kap. 15-16 §§)', () => {
  it('is 300 % of the utgift', () => {
    expect(AMOUNT_BLOCK_MULTIPLIER).toBe(3)
    expect(amountBlockLimit(100_000, 0)).toBe(300_000)
  })

  it('reduces the utgift by kapitaltillskott, never below zero', () => {
    expect(amountBlockLimit(250_000, 50_000)).toBe(600_000)
    expect(amountBlockLimit(100_000, 150_000)).toBe(0)
  })

  it('cuts the deficit above 300 % of the utgift less tillskott, for good', () => {
    // Deficit 1 000 000 brought into the year of the change; utgift 250 000,
    // tillskott 50 000 the year before: limit 3 x 200 000 = 600 000.
    const r = computeLossYear({
      ...base,
      broughtForward: 1_000_000,
      resultBeforeDeficit: 100_000,
      amountBlock: { acquisitionCost: 250_000, capitalContributions: 50_000 },
    })
    expect(r).toMatchObject({
      amountBlockLimit: 600_000,
      computedAmountBlockReduction: 400_000,
      amountBlockReduction: 400_000,
      deductible: 600_000,
      taxableResult: -500_000,
      carriedForward: 500_000,
    })
  })

  it('cuts nothing when the deficit is within the limit', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 300_000,
      resultBeforeDeficit: 0,
      amountBlock: { acquisitionCost: 200_000, capitalContributions: 0 },
    })
    expect(r.amountBlockReduction).toBe(0)
    expect(r.carriedForward).toBe(300_000)
  })

  it('cuts the whole deficit when tillskott exceed the utgift', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 400_000,
      resultBeforeDeficit: 50_000,
      amountBlock: { acquisitionCost: 100_000, capitalContributions: 150_000 },
    })
    expect(r).toMatchObject({ amountBlockReduction: 400_000, deductible: 0, taxableResult: 50_000, carriedForward: 0 })
  })

  it('warns and cuts nothing while the utgift is missing', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 400_000,
      resultBeforeDeficit: 0,
      amountBlock: { acquisitionCost: null, capitalContributions: 0 },
    })
    expect(r.amountBlockReduction).toBe(0)
    expect(r.computedAmountBlockReduction).toBeNull()
    expect(r.warnings).toEqual(['amount_block_missing_cost'])
  })

  it('takes a manual 4.14 b (40:17 a, ackord, konkurs) and says when it differs from the computed one', () => {
    const lostAll = computeLossYear({ ...base, broughtForward: 200_000, resultBeforeDeficit: 50_000, manualAmountBlockReduction: 200_000 })
    expect(lostAll).toMatchObject({ amountBlockReduction: 200_000, taxableResult: 50_000, carriedForward: 0, warnings: [] })

    const differs = computeLossYear({
      ...base,
      broughtForward: 1_000_000,
      resultBeforeDeficit: 0,
      amountBlock: { acquisitionCost: 250_000, capitalContributions: 0 },
      manualAmountBlockReduction: 100_000,
    })
    expect(differs.amountBlockReduction).toBe(100_000)
    expect(differs.computedAmountBlockReduction).toBe(250_000)
    expect(differs.warnings).toEqual(['amount_block_manual_differs'])
  })

  it('never cuts more than was brought forward', () => {
    const r = computeLossYear({ ...base, broughtForward: 10_000, resultBeforeDeficit: 0, manualAmountBlockReduction: 50_000 })
    expect(r.amountBlockReduction).toBe(10_000)
  })
})

describe('computeLossYear: koncernbidragsspärr (IL 40 kap. 18 §)', () => {
  it('lasts through the fifth beskattningsår after the year it entered', () => {
    expect(defaultGroupBlockLastYear(2026)).toBe(2031)
  })

  it('caps the old deficit at the överskott without koncernbidrag in the year of the change', () => {
    // Result 400 000 of which 300 000 is koncernbidrag received: only
    // 100 000 of the old deficit is deducted, 400 000 waits (4.14 c).
    const r = computeLossYear({
      ...base,
      broughtForward: 500_000,
      resultBeforeDeficit: 400_000,
      groupContributionsReceived: 300_000,
      groupBlock: { kind: 'change_year' },
    })
    expect(r).toMatchObject({
      computedGroupBlockReduction: 400_000,
      groupBlockReduction: 400_000,
      deductible: 100_000,
      taxableResult: 300_000,
      carriedForward: 400_000,
    })
  })

  it('applies the cap to what the beloppsspärr leaves', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 1_000_000,
      resultBeforeDeficit: 250_000,
      groupContributionsReceived: 200_000,
      amountBlock: { acquisitionCost: 100_000, capitalContributions: 0 },
      groupBlock: { kind: 'change_year' },
    })
    expect(r).toMatchObject({
      amountBlockReduction: 700_000,
      groupBlockReduction: 250_000,
      deductible: 50_000,
      taxableResult: 200_000,
      carriedForward: 250_000,
    })
  })

  it('keeps the whole spärrat pool on 4.14 c in a loss year, and carries it with the new deficit', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 400_000,
      resultBeforeDeficit: -50_000,
      groupBlock: { kind: 'continuing', pool: 400_000 },
    })
    expect(r).toMatchObject({ groupBlockReduction: 400_000, deductible: 0, taxableResult: -50_000, carriedForward: 450_000 })
  })

  it('lets the pool go once the överskott without koncernbidrag covers it; new deficits are never spärrade', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 450_000,
      resultBeforeDeficit: 600_000,
      groupContributionsReceived: 100_000,
      groupBlock: { kind: 'continuing', pool: 400_000 },
    })
    expect(r).toMatchObject({ groupBlockReduction: 0, deductible: 450_000, taxableResult: 150_000, carriedForward: 0 })
  })

  it('warns instead of guessing when the year\'s result or the previous year is missing', () => {
    const noResult = computeLossYear({ ...base, broughtForward: 100_000, groupBlock: { kind: 'change_year' } })
    expect(noResult.groupBlockReduction).toBe(0)
    expect(noResult.warnings).toEqual(['group_block_missing_result'])

    const noPool = computeLossYear({
      ...base,
      broughtForward: 100_000,
      resultBeforeDeficit: 10_000,
      groupBlock: { kind: 'continuing', pool: null },
    })
    expect(noPool.groupBlockReduction).toBe(0)
    expect(noPool.warnings).toEqual(['group_block_missing_pool'])
  })

  it('takes a manual 4.14 c and says when it differs', () => {
    const r = computeLossYear({
      ...base,
      broughtForward: 500_000,
      resultBeforeDeficit: 400_000,
      groupContributionsReceived: 300_000,
      groupBlock: { kind: 'change_year' },
      manualGroupBlockReduction: 350_000,
    })
    expect(r.groupBlockReduction).toBe(350_000)
    expect(r.warnings).toEqual(['group_block_manual_differs'])
    expect(r.carriedForward).toBe(350_000)
  })
})
