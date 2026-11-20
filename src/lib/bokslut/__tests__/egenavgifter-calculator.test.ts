import { describe, it, expect } from 'vitest'
import { calculateEgenavgifter } from '../enskild-firma/egenavgifter-calculator'

describe('calculateEgenavgifter', () => {
  it('full rate: 25 % schablonavdrag on positive surplus', () => {
    const r = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 200_000,
      category: 'full',
    })
    // No prior-year adjustments → net = 200 000, schablon 25 % = 50 000
    expect(r.amount).toBe(50_000)
    expect(r.ne_ruta).toBe('R43')
  })

  it('pensioner: 10 % schablonavdrag', () => {
    const r = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 200_000,
      category: 'pensioner',
    })
    expect(r.amount).toBe(20_000)
  })

  it('passive: 20 % schablonavdrag (SLP base)', () => {
    const r = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 200_000,
      category: 'passive',
    })
    expect(r.amount).toBe(40_000)
  })

  it('takes the schablon of R42 as given: the R40/R41 avstämning is already in it', () => {
    // R42 = 200 000 + 30 000 (R40) - 25 000 (R41) = 205 000, summed by the
    // preview (ef-declaration-preview.test.ts). 25 % = 51 250.
    const r = calculateEgenavgifter({ surplusBeforeEgenavgifter: 205_000, category: 'full' })
    expect(r.amount).toBe(51_250)
    expect(r.computation).toMatchObject({ surplusBeforeEgenavgifter: 205_000, schablonavdrag: 51_250 })
  })

  it('drops the öre of the schablon (SFL 22 kap 1 §)', () => {
    // 25 % of 100 003 = 25 000,75
    expect(calculateEgenavgifter({ surplusBeforeEgenavgifter: 100_003 }).amount).toBe(25_000)
  })

  it('returns 0 amount on loss year and emits warning', () => {
    const r = calculateEgenavgifter({
      surplusBeforeEgenavgifter: -10_000,
      category: 'full',
    })
    expect(r.amount).toBe(0)
    expect(r.warnings).toContainEqual(expect.stringMatching(/inget överskott/i))
  })

  it('surfaces the 7.5 % nedsättning hint for active surplus > 40 000', () => {
    const r = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 100_000,
      category: 'full',
    })
    expect(r.warnings.some((w) => /7,5/.test(w))).toBe(true)
  })
})
