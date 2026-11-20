import { describe, it, expect } from 'vitest'
import { calculateLoneVaxlingPensionProvision } from '../lonevaxling'

const slpRate = 0.2426

const r = (x: number) => Math.round(x * 100) / 100

describe('calculateLoneVaxlingPensionProvision', () => {
  it('applies 1.058 factor to pension contribution', () => {
    const result = calculateLoneVaxlingPensionProvision(5000, slpRate)
    expect(result.pensionContribution).toBe(r(5000 * 1.058))
  })

  it('calculates SLP on pension at 24.26%', () => {
    const result = calculateLoneVaxlingPensionProvision(5000, slpRate)
    const expectedSlp = r(5000 * 1.058 * 0.2426)
    expect(result.slpOnPension).toBe(expectedSlp)
  })
})
