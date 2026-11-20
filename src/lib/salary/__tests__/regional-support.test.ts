import { describe, it, expect } from 'vitest'
import {
  computeRegionalSupport,
  regionalSupportEnabled,
  regionalSupportForRun,
  REGIONAL_SUPPORT_MAX_PER_PERIOD,
} from '../regional-support'
import { declaredAvgifterForRun, type DeclaredAvgifterRunRow } from '../declared-avgifter'

// Regionalt stöd (PH 208): lag (2001:1170) 2 §, Skatteverket kontroller
// S_106/S_108/S_109 and B_002. 10 % of the underlag, at most 7 100 kr per
// redovisningsperiod; only rows above the ålderspensionsavgift form underlag.

const row = (over: Partial<Parameters<typeof computeRegionalSupport>[0][number]> = {}) => ({
  basis: 30000,
  rate: 0.3142,
  category: 'standard' as string | null,
  overrideAmount: null as number | null,
  ...over,
})

describe('computeRegionalSupport', () => {
  it('deducts 10 % of the underlag, öretal dropped', () => {
    expect(computeRegionalSupport([row({ basis: 30000 }), row({ basis: 12345.67 })])).toEqual({
      underlag: 42345,
      deduction: 4234,
    })
  })

  it('caps the avdrag at 7 100 kr per period but declares the whole underlag', () => {
    const support = computeRegionalSupport([row({ basis: 50000 }), row({ basis: 40000 })])
    expect(support).toEqual({ underlag: 90000, deduction: REGIONAL_SUPPORT_MAX_PER_PERIOD })
    expect(REGIONAL_SUPPORT_MAX_PER_PERIOD).toBe(7100)
  })

  it('counts youth-rate rows (B_002 allows full-rate plus youth underlag)', () => {
    expect(computeRegionalSupport([row({ basis: 20000, rate: 0.2081, category: 'youth' })])).toEqual({
      underlag: 20000,
      deduction: 2000,
    })
  })

  it('leaves out rows where only ålderspensionsavgift is paid (67+ at the start of the year)', () => {
    const support = computeRegionalSupport([
      row({ basis: 30000 }),
      row({ basis: 25000, rate: 0.1021, category: 'reduced_65plus' }),
      // Legacy row without a category: resolved by rate, like the AGI does.
      row({ basis: 25000, rate: 0.1021, category: null }),
    ])
    expect(support).toEqual({ underlag: 30000, deduction: 3000 })
  })

  it('leaves out rows with no avgift and rows with a manual avgift', () => {
    expect(
      computeRegionalSupport([
        row({ basis: 30000, rate: 0, category: 'exempt' }),
        row({ basis: 0 }),
        row({ basis: 30000, overrideAmount: 6426 }),
        row({ basis: -5000 }),
      ]),
    ).toBeNull()
  })

  it('is null when nothing qualifies, so HU carries neither field (S_106/S_108)', () => {
    expect(computeRegionalSupport([])).toBeNull()
    // 9 kr underlag gives a 0 kr avdrag: nothing to declare.
    expect(computeRegionalSupport([row({ basis: 9 })])).toBeNull()
  })
})

describe('regionalSupportForRun', () => {
  const runRow = (over: Partial<DeclaredAvgifterRunRow> = {}): DeclaredAvgifterRunRow => ({
    avgifter_basis: 30000,
    avgifter_rate: 0.3142,
    avgifter_category: 'standard',
    ...over,
  })
  const on = { avgifterTotal: 0.3142, salary_regional_support: true }

  it('is off unless the run snapshot says so', () => {
    expect(regionalSupportEnabled(null)).toBe(false)
    expect(regionalSupportEnabled({ avgifterTotal: 0.3142 })).toBe(false)
    expect(regionalSupportEnabled({ salary_regional_support: 'true' })).toBe(false)
    expect(regionalSupportForRun([runRow()], { avgifterTotal: 0.3142 })).toBeNull()
    expect(regionalSupportForRun([runRow()], on)).toEqual({ underlag: 30000, deduction: 3000 })
  })

  it('reads the rows FK487 reads: no borttag tombstones, no F-skatt payees', () => {
    const rows = [
      runRow(),
      runRow({ removed_from_agi: true }),
      runRow({ employee: { f_skatt_status: 'f_skatt' } }),
    ]
    expect(regionalSupportForRun(rows, on)).toEqual({ underlag: 30000, deduction: 3000 })
    // The declared underlag of the same rows is the same 30 000.
    expect(declaredAvgifterForRun(rows, on).totalUnderlag).toBe(30000)
  })
})
