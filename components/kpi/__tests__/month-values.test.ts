import { describe, expect, it } from 'vitest'
import { allLabelsFit, compactKr, estimateLabelWidth, BAR_LABEL_FONT_PX } from '../month-values'

// Twelve months in the 320-unit viewBox: the slot every label must fit in.
const SLOT = 320 / 12

const NBSP = String.fromCharCode(160)
const MINUS = String.fromCharCode(0x2212)

/** Intl emits no-break spaces and a real minus sign; compare on plain ASCII. */
function ascii(s: string): string {
  return s.split(NBSP).join(' ').split(MINUS).join('-')
}

function labelsFor(nets: number[]): string[] {
  return nets.map((n) => (n === 0 ? '' : compactKr(n)))
}

describe('compactKr', () => {
  it('formats in Swedish compact notation with at most one decimal', () => {
    expect(ascii(compactKr(12_000))).toBe('12 tn')
    expect(ascii(compactKr(-3_400))).toBe('-3,4 tn')
    expect(ascii(compactKr(950))).toBe('950')
    expect(ascii(compactKr(1_250_000))).toBe('1,3 mn')
  })
})

describe('estimateLabelWidth', () => {
  it('treats the no-break space and thin glyphs as narrower than digits', () => {
    expect(estimateLabelWidth(compactKr(12_000))).toBeLessThan(estimateLabelWidth('12345'))
    expect(estimateLabelWidth('')).toBe(0)
  })
})

describe('allLabelsFit', () => {
  it('labels every bar for a year of whole-thousand months, negatives included', () => {
    const labels = labelsFor([8_000, -9_000, 0, 12_000, 25_000, 0, -4_000, 15_000, 7_000, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT)).toBe(true)
  })

  it('falls back to the single latest label once a decimal negative would collide', () => {
    // "-3,4 tn" is the widest common shape: seven glyphs in one twelve-bar slot.
    const labels = labelsFor([8_200, -3_400, 0, 12_000, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT)).toBe(false)
  })

  it('falls back for six-figure months', () => {
    const labels = labelsFor([123_000, -198_000, 45_000, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT)).toBe(false)
  })

  it('ignores empty labels and treats an all-zero year as fitting', () => {
    expect(allLabelsFit(['', '', ''], SLOT)).toBe(true)
  })

  it('scales with the slot width, so fewer months allow wider labels', () => {
    const wide = labelsFor([-123_000, 145_000])
    expect(allLabelsFit(wide, SLOT)).toBe(false)
    expect(allLabelsFit(wide, 320 / 4)).toBe(true)
  })

  it('accounts for the font size it is given', () => {
    const labels = labelsFor([12_000])
    expect(allLabelsFit(labels, SLOT, BAR_LABEL_FONT_PX)).toBe(true)
    expect(allLabelsFit(labels, SLOT, 20)).toBe(false)
  })
})
