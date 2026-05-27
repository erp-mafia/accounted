import { describe, it, expect } from 'vitest'
import {
  computeJamkningAmount,
  assessJamkningEligibility,
} from '../jamkning'

describe('computeJamkningAmount', () => {
  it('5-year asset sold after 3 years (24 months remaining, 20 000 kr input VAT) → 8 000 kr', () => {
    // ML 8a kap 7 §: (24 / 60) × 20 000 = 8 000
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: 60,
      remainingMonths: 24,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(8_000)
  })

  it('10-year fastighet sold after 7 years (36 months remaining, 200 000 kr input VAT) → 60 000 kr', () => {
    // ML 8a kap 7 §: (36 / 120) × 200 000 = 60 000
    const amount = computeJamkningAmount({
      originalInputVat: 200_000,
      totalCorrectionMonths: 120,
      remainingMonths: 36,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(60_000)
  })

  it('sold after the correction period (0 remaining) → 0', () => {
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: 60,
      remainingMonths: 0,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(0)
  })

  it('sold immediately (60 months remaining on 60-month period) → full originalInputVat', () => {
    // (60 / 60) × 20 000 = 20 000 — the full deduction must be reversed
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: 60,
      remainingMonths: 60,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(20_000)
  })

  it('returns 0 when disposalEvent is no_jamkning', () => {
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: 60,
      remainingMonths: 24,
      disposalEvent: 'no_jamkning',
    })
    expect(amount).toBe(0)
  })

  it('caps remaining months at totalCorrectionMonths (defensive)', () => {
    // A caller bug could pass remainingMonths > totalCorrectionMonths.
    // Cap at the total so the answer never exceeds originalInputVat.
    const amount = computeJamkningAmount({
      originalInputVat: 10_000,
      totalCorrectionMonths: 60,
      remainingMonths: 120,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(10_000)
  })

  it('handles negligible cost (zero originalInputVat) → 0 without NaN', () => {
    const amount = computeJamkningAmount({
      originalInputVat: 0,
      totalCorrectionMonths: 60,
      remainingMonths: 24,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(0)
    expect(Number.isNaN(amount)).toBe(false)
  })

  it('returns 0 when totalCorrectionMonths is 0 (avoid divide-by-zero)', () => {
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: 0,
      remainingMonths: 0,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(0)
    expect(Number.isFinite(amount)).toBe(true)
  })

  it('returns 0 when totalCorrectionMonths is negative (defensive)', () => {
    const amount = computeJamkningAmount({
      originalInputVat: 20_000,
      totalCorrectionMonths: -60,
      remainingMonths: -24,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(0)
    expect(Number.isFinite(amount)).toBe(true)
  })

  it('rounds to two decimals (no öre stray cents)', () => {
    // (17 / 60) × 10 000 = 2833.333... → 2833.33
    const amount = computeJamkningAmount({
      originalInputVat: 10_000,
      totalCorrectionMonths: 60,
      remainingMonths: 17,
      disposalEvent: 'triggers_jamkning',
    })
    expect(amount).toBe(2_833.33)
  })
})

describe('assessJamkningEligibility', () => {
  it('returns 120 months for fastighet BAS 1110', () => {
    const e = assessJamkningEligibility({
      basAssetAccount: '1110',
      basExpenseAccount: '7821',
      category: 'building',
      acquisitionDate: '2020-01-01',
      disposalDate: '2026-01-01',
    })
    expect(e.totalCorrectionMonths).toBe(120)
    // 6 years = 72 months elapsed → 48 months remaining
    expect(e.elapsedMonths).toBe(72)
    expect(e.remainingMonths).toBe(48)
    expect(e.withinCorrectionPeriod).toBe(true)
  })

  it('returns 60 months for equipment BAS 1220', () => {
    const e = assessJamkningEligibility({
      basAssetAccount: '1220',
      basExpenseAccount: '7832',
      category: 'equipment',
      acquisitionDate: '2024-01-01',
      disposalDate: '2026-01-01',
    })
    expect(e.totalCorrectionMonths).toBe(60)
    // 2 years = 24 months → 36 months remaining
    expect(e.elapsedMonths).toBe(24)
    expect(e.remainingMonths).toBe(36)
    expect(e.withinCorrectionPeriod).toBe(true)
  })

  it('detects markanläggning (BAS 1150) as real property → 120 months', () => {
    const e = assessJamkningEligibility({
      basAssetAccount: '1150',
      basExpenseAccount: '7824',
      category: 'land_improvement',
      acquisitionDate: '2023-06-01',
      disposalDate: '2024-06-01',
    })
    expect(e.totalCorrectionMonths).toBe(120)
  })

  it('falls back to category when account is unrecognized', () => {
    // No BAS account provided — has to rely on the category signal.
    const e = assessJamkningEligibility({
      category: 'building',
      acquisitionDate: '2024-01-01',
      disposalDate: '2026-01-01',
    })
    expect(e.totalCorrectionMonths).toBe(120)
  })

  it('reports withinCorrectionPeriod = false after the full period elapses', () => {
    const e = assessJamkningEligibility({
      basAssetAccount: '1220',
      category: 'equipment',
      acquisitionDate: '2020-01-01',
      disposalDate: '2026-01-01',
    })
    // 6 years = 72 months elapsed > 60 → 0 remaining
    expect(e.remainingMonths).toBe(0)
    expect(e.withinCorrectionPeriod).toBe(false)
  })

  it('counts complete months only (day-precision)', () => {
    // 2023-01-15 to 2026-01-14 → 35 complete months (the 36th hasn't finished)
    const e = assessJamkningEligibility({
      basAssetAccount: '1220',
      category: 'equipment',
      acquisitionDate: '2023-01-15',
      disposalDate: '2026-01-14',
    })
    expect(e.elapsedMonths).toBe(35)
    expect(e.remainingMonths).toBe(25)
  })

  it('clamps elapsedMonths to 0 if disposalDate precedes acquisitionDate', () => {
    // Defensive — should never happen in practice but must not blow up.
    const e = assessJamkningEligibility({
      basAssetAccount: '1220',
      category: 'equipment',
      acquisitionDate: '2026-01-01',
      disposalDate: '2024-01-01',
    })
    expect(e.elapsedMonths).toBe(0)
    expect(e.remainingMonths).toBe(60)
  })
})
