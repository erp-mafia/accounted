import { describe, it, expect } from 'vitest'
import { calculateRantefordelning, NEGATIVE_THRESHOLD } from '../enskild-firma/rantefordelning-calculator'

describe('calculateRantefordelning', () => {
  it('positive: SLR+6 pe × kapitalunderlag', () => {
    // SLR 2025-11-30 = 2.55 %, +6 = 8.55 %. 1 000 000 × 0.0855 = 85 500
    const r = calculateRantefordelning({ kapitalunderlag: 1_000_000 })
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('rantefordelning_positive')
    expect(r!.amount).toBe(85_500)
  })

  it('returns null between 0 and the -500 000 negative threshold', () => {
    expect(calculateRantefordelning({ kapitalunderlag: 0 })).toBeNull()
    expect(calculateRantefordelning({ kapitalunderlag: -100_000 })).toBeNull()
    expect(calculateRantefordelning({ kapitalunderlag: NEGATIVE_THRESHOLD })).toBeNull()
  })

  it('negative: SLR+1 pe × |kapitalunderlag| when under -500 000', () => {
    // -600 000 < -500 000. 600 000 × (0.0255 + 0.01) = 21 300
    const r = calculateRantefordelning({ kapitalunderlag: -600_000 })
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('rantefordelning_negative')
    expect(r!.amount).toBe(21_300)
    expect(r!.warnings[0]).toContain('-500 000')
  })

  it('honors a custom SLR rate', () => {
    // For inkomstår 2025: SLR = 1.96 %. Positive at +6 = 7.96 %. On 100 000 = 7 960
    const r = calculateRantefordelning({ kapitalunderlag: 100_000, slrRate: 0.0196 })
    expect(r).not.toBeNull()
    expect(r!.amount).toBe(7_960)
  })
})
