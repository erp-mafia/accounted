import { describe, expect, it } from 'vitest'
import { getContrastRatio, isWcagAACompliant } from '@/lib/invoices/contrast-check'

describe('getContrastRatio', () => {
  it('returns 21 for black on white (maximum contrast)', () => {
    const ratio = getContrastRatio('#000000', '#ffffff')
    expect(ratio).toBeCloseTo(21, 1)
  })

  it('returns 21 regardless of argument order (white on black)', () => {
    const ratio = getContrastRatio('#ffffff', '#000000')
    expect(ratio).toBeCloseTo(21, 1)
  })

  it('returns 1 for identical colors (white on white)', () => {
    const ratio = getContrastRatio('#ffffff', '#ffffff')
    expect(ratio).toBeCloseTo(1, 5)
  })

  it('returns 1 for identical colors (black on black)', () => {
    const ratio = getContrastRatio('#000000', '#000000')
    expect(ratio).toBeCloseTo(1, 5)
  })

  it('PDF default heading color #1a1a1a on white passes AA with ratio > 15', () => {
    const ratio = getContrastRatio('#1a1a1a', '#ffffff')
    expect(ratio).toBeGreaterThan(15)
  })

  it('yellow #ffff00 on white has very low contrast (~1.07), fails AA', () => {
    const ratio = getContrastRatio('#ffff00', '#ffffff')
    expect(ratio).toBeGreaterThan(1.0)
    expect(ratio).toBeLessThan(1.2)
  })

  it('accepts uppercase hex', () => {
    const lower = getContrastRatio('#1a1a1a', '#ffffff')
    const upper = getContrastRatio('#1A1A1A', '#FFFFFF')
    expect(upper).toBeCloseTo(lower, 5)
  })

  it('throws on invalid hex format', () => {
    expect(() => getContrastRatio('1a1a1a', '#ffffff')).toThrow()
    expect(() => getContrastRatio('#fff', '#ffffff')).toThrow()
    expect(() => getContrastRatio('#zzzzzz', '#ffffff')).toThrow()
  })
})

describe('isWcagAACompliant', () => {
  it('passes for the PDF default primary color (#1a1a1a) on white', () => {
    expect(isWcagAACompliant('#1a1a1a', '#ffffff')).toBe(true)
  })

  it('passes for the PDF default accent color (#666666) on white', () => {
    // 5.74:1: comfortably above AA threshold.
    expect(isWcagAACompliant('#666666', '#ffffff')).toBe(true)
  })

  it('fails for pure yellow on white', () => {
    expect(isWcagAACompliant('#ffff00', '#ffffff')).toBe(false)
  })

  // Accounted brand semantic colors. All three are used as DATA-ONLY indicators
  // (charts, positive/negative deltas), never as chrome text on white. These
  // tests document where they sit relative to AA: terracotta/destructive is
  // the only one that comfortably passes AA on white.
  it('Accounted terracotta (#c2410c equivalent dark red) passes AA on white', () => {
    // 5.91:1: passes AA for normal text.
    expect(isWcagAACompliant('#c2410c', '#ffffff')).toBe(true)
  })

  it('Accounted sage (#84a98c lighter green) fails AA on white', () => {
    // ~2.4:1: fails AA, as expected for a soft pastel sage.
    expect(isWcagAACompliant('#84a98c', '#ffffff')).toBe(false)
  })

  it('Accounted ochre (#d4a373 warm yellow) fails AA on white', () => {
    // ~2.3:1: fails AA, as expected for a warm soft ochre.
    expect(isWcagAACompliant('#d4a373', '#ffffff')).toBe(false)
  })

  it('a very dark sage (#2d5a3e) passes AA on white', () => {
    expect(isWcagAACompliant('#2d5a3e', '#ffffff')).toBe(true)
  })
})
