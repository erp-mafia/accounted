import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events'
import {
  computeDeclaredAvgifter,
  computeDeclaredAvgifterWithOverrides,
  declaredAvgifterByCategory,
  reportingCategory,
  resolveDeclaredAvgifterParams,
} from '../declared-avgifter'

const PARAMS = { standardRate: 0.3142, youthCap: 25000, vaxaCap: 35000 }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('computeDeclaredAvgifter', () => {
  it('reproduces Skatteverket: per-sats on whole-krona underlag sums, not per-employee öre sums', () => {
    // The refuting counterexample from the skeptic pass: 4 hourly employees
    // at 30 000,99 kr. Per-employee öre math gives 4 × 9 426,31 = 37 705,24
    // → 37 705 truncated once, but Skatteverket declares 30 000 per IU and
    // computes trunc(120 000 × 31,42 %) = trunc(37 704,00) = 37 704.
    const rows = Array.from({ length: 4 }, () => ({
      basis: 30000.99,
      rate: 0.3142,
      category: 'standard',
    }))
    const declared = computeDeclaredAvgifter(rows, PARAMS)
    expect(declared.totalUnderlag).toBe(120000)
    expect(declared.totalAmount).toBe(37704)
  })

  it('splits a youth above the monthly cap between the reduced and full sats', () => {
    // Underlag 30 000, youth cap 25 000: trunc(25 000 × 20,81 %) = 5 202
    // (öretal bortfaller on 5 202,50) + trunc(5 000 × 31,42 %) = 1 571.
    const declared = computeDeclaredAvgifter(
      [{ basis: 30000, rate: 0.2081, category: 'youth' }],
      PARAMS,
    )
    expect(declared.totalAmount).toBe(5202 + 1571)
    const byCategory = declaredAvgifterByCategory(declared)
    expect(byCategory.youth).toEqual({ basis: 25000, amount: 5202 })
    expect(byCategory.standard).toEqual({ basis: 5000, amount: 1571 })
  })

  it('splits växa-stöd above the cap and reports both parts under standard', () => {
    // Underlag 40 000, växa cap 35 000: trunc(35 000 × 10,21 %) = 3 573
    // (öretal bortfaller on 3 573,50) + trunc(5 000 × 31,42 %) = 1 571.
    // Växa-stöd has no own category in the AGI map (FK062/FK063 are IU
    // flags), so everything folds into standard.
    const declared = computeDeclaredAvgifter(
      [{ basis: 40000, rate: 0.1021, category: 'vaxa_stod' }],
      PARAMS,
    )
    expect(declared.totalAmount).toBe(3573 + 1571)
    expect(declaredAvgifterByCategory(declared)).toEqual({
      standard: { basis: 40000, amount: 5144 },
    })
  })

  it('caps a legacy null-category row that the rate heuristic classifies as youth', () => {
    // Legacy rows predate the avgifter_category column: the rate heuristic
    // resolves them, and the youth cap must key on that RESOLVED category or
    // a legacy youth above the cap gets the reduced sats on the full
    // underlag (1 041 kr too little declared on this fixture).
    const declared = computeDeclaredAvgifter(
      [{ basis: 30000, rate: 0.2081, category: null }],
      PARAMS,
    )
    expect(declared.totalAmount).toBe(5202 + 1571)
  })

  it('applies no cap split when the cap is null or the category is uncapped', () => {
    const noCaps = computeDeclaredAvgifter(
      [{ basis: 30000, rate: 0.2081, category: 'youth' }],
      { standardRate: 0.3142, youthCap: null, vaxaCap: null },
    )
    expect(noCaps.totalAmount).toBe(Math.trunc((30000 * 2081) / 10000))

    const reduced = computeDeclaredAvgifter(
      [{ basis: 20000.5, rate: 0.1021, category: 'reduced_65plus' }],
      PARAMS,
    )
    expect(reduced.totalUnderlag).toBe(20000)
    expect(reduced.totalAmount).toBe(2042)
    expect(declaredAvgifterByCategory(reduced)).toEqual({
      reduced65plus: { basis: 20000, amount: 2042 },
    })
  })

  it('skips F-skatt/exempt rows (zero basis or zero rate)', () => {
    const declared = computeDeclaredAvgifter(
      [
        { basis: 0, rate: 0.3142, category: 'standard' },
        { basis: 15000, rate: 0, category: 'exempt' },
        { basis: 10000, rate: 0.3142, category: 'standard' },
      ],
      PARAMS,
    )
    expect(declared.totalUnderlag).toBe(10000)
    expect(declared.totalAmount).toBe(3142)
  })

  it('always cross-foots: the category breakdown sums exactly to the total', () => {
    const declared = computeDeclaredAvgifter(
      [
        { basis: 30000.99, rate: 0.3142, category: 'standard' },
        { basis: 28000.45, rate: 0.2081, category: 'youth' },
        { basis: 12345.67, rate: 0.1021, category: 'reduced_65plus' },
        { basis: 41000.01, rate: 0.1021, category: 'vaxa_stod' },
      ],
      PARAMS,
    )
    const byCategory = declaredAvgifterByCategory(declared)
    const catSum = Object.values(byCategory).reduce((s, c) => s + (c?.amount ?? 0), 0)
    expect(catSum).toBe(declared.totalAmount)
    const basisSum = Object.values(byCategory).reduce((s, c) => s + (c?.basis ?? 0), 0)
    expect(basisSum).toBe(declared.totalUnderlag)
    expect(Number.isInteger(declared.totalAmount)).toBe(true)
    expect(Number.isInteger(declared.totalUnderlag)).toBe(true)
  })
})

describe('computeDeclaredAvgifterWithOverrides', () => {
  it('keeps colleagues SKV-exact when one employee carries an amount override', () => {
    // FoU-avdrag override 7 855 on E1; E2+E3 are ordinary öre-wage rows.
    // The colleagues must still declare trunc(60 000 × 31,42 %) = 18 852
    // (per-sats on summed whole-krona underlag), NOT a truncation of their
    // öre-exact charges: total = 18 852 + 7 855.
    const declared = computeDeclaredAvgifterWithOverrides(
      [
        { basis: 51158, rate: 0.3142, category: 'standard', overrideAmount: 7855 },
        { basis: 30000.99, rate: 0.3142, category: 'standard' },
        { basis: 30000.99, rate: 0.3142, category: 'standard' },
      ],
      PARAMS,
    )
    expect(declared.totalAmount).toBe(18852 + 7855)
    const catSum = Object.values(declared.byCategory).reduce((s, c) => s + (c?.amount ?? 0), 0)
    expect(catSum).toBe(declared.totalAmount)
  })

  it('degenerates to the pure underlag computation when nothing is overridden', () => {
    const rows = [
      { basis: 30000.99, rate: 0.3142, category: 'standard' },
      { basis: 28000, rate: 0.2081, category: 'youth' },
    ]
    const hybrid = computeDeclaredAvgifterWithOverrides(rows, PARAMS)
    const pure = computeDeclaredAvgifter(rows, PARAMS)
    expect(hybrid.totalAmount).toBe(pure.totalAmount)
    expect(hybrid.totalUnderlag).toBe(pure.totalUnderlag)
  })

  it('truncates override amounts per category and cross-foots', () => {
    const declared = computeDeclaredAvgifterWithOverrides(
      [
        { basis: 51158, rate: 0.3142, category: 'standard', overrideAmount: 16075.9 },
      ],
      PARAMS,
    )
    expect(declared.totalAmount).toBe(16075)
    expect(declared.byCategory.standard?.amount).toBe(16075)
    expect(declared.byCategory.standard?.basis).toBe(51158)
  })
})

describe('reportingCategory', () => {
  it('maps DB categories and falls back to the rate heuristic for legacy nulls', () => {
    expect(reportingCategory({ rate: 0.3142, category: 'standard' })).toBe('standard')
    expect(reportingCategory({ rate: 0.1021, category: 'reduced_65plus' })).toBe('reduced65plus')
    expect(reportingCategory({ rate: 0.1021, category: 'vaxa_stod' })).toBe('standard')
    expect(reportingCategory({ rate: 0.2081, category: 'youth' })).toBe('youth')
    expect(reportingCategory({ rate: 0.3142, category: null })).toBe('standard')
    expect(reportingCategory({ rate: 0.1021, category: null })).toBe('reduced65plus')
    expect(reportingCategory({ rate: 0.2081, category: null })).toBe('youth')
  })
})

describe('resolveDeclaredAvgifterParams', () => {
  it('reads the frozen payroll-config snapshot', () => {
    expect(
      resolveDeclaredAvgifterParams({
        avgifterTotal: 0.3142,
        avgifterYouthSalaryCap: 25000,
        avgifterVaxaStodCap: 35000,
      }),
    ).toEqual({ standardRate: 0.3142, youthCap: 25000, vaxaCap: 35000 })
  })

  it('falls back to the statutory 31,42 % and no caps for legacy runs', () => {
    expect(resolveDeclaredAvgifterParams(null)).toEqual({
      standardRate: 0.3142,
      youthCap: null,
      vaxaCap: null,
    })
    expect(resolveDeclaredAvgifterParams({ avgifterYouthSalaryCap: 'bogus' })).toEqual({
      standardRate: 0.3142,
      youthCap: null,
      vaxaCap: null,
    })
  })
})
