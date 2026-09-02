import { describe, expect, it } from 'vitest'
import {
  allLabelsFit,
  barLabel,
  compactKr,
  estimateLabelWidth,
  BAR_LABEL_FONT_PX,
  LATEST_LABEL_FONT_PX,
} from '../month-values'

// Twelve months in the 320-unit viewBox: the slot every label must fit in.
const SLOT = 320 / 12

const NBSP = String.fromCharCode(160)
const MINUS = String.fromCharCode(0x2212)

/** Intl emits no-break spaces and a real minus sign; compare on plain ASCII. */
function ascii(s: string): string {
  return s.split(NBSP).join(' ').split(MINUS).join('-')
}

function labelsFor(nets: number[]): string[] {
  return nets.map(barLabel)
}

describe('compactKr', () => {
  it('formats in Swedish compact notation with at most one decimal', () => {
    expect(ascii(compactKr(12_000))).toBe('12 tn')
    expect(ascii(compactKr(-3_400))).toBe('-3,4 tn')
    expect(ascii(compactKr(950))).toBe('950')
    expect(ascii(compactKr(1_250_000))).toBe('1,3 mn')
  })

  it('never prints a minus on a value that rounds to zero', () => {
    expect(ascii(compactKr(-0.04))).toBe('0')
    expect(ascii(compactKr(-0))).toBe('0')
    expect(ascii(compactKr(-0.05))).toBe('-0,1')
  })
})

describe('barLabel', () => {
  it('is blank for an empty month and for öre that would round to nothing', () => {
    expect(barLabel(0)).toBe('')
    expect(barLabel(-0.03)).toBe('')
    expect(barLabel(0.04)).toBe('')
  })

  it('carries the compact value otherwise', () => {
    expect(ascii(barLabel(-0.05))).toBe('-0,1')
    expect(ascii(barLabel(12_000))).toBe('12 tn')
  })
})

describe('estimateLabelWidth', () => {
  it('treats the no-break space and thin glyphs as narrower than digits', () => {
    expect(estimateLabelWidth(compactKr(12_000))).toBeLessThan(estimateLabelWidth('12345'))
    expect(estimateLabelWidth('')).toBe(0)
  })

  it('grows with the font size', () => {
    const label = compactKr(12_000)
    expect(estimateLabelWidth(label, LATEST_LABEL_FONT_PX)).toBeGreaterThan(
      estimateLabelWidth(label, BAR_LABEL_FONT_PX),
    )
  })
})

describe('allLabelsFit', () => {
  it('labels every bar for a year of whole-thousand months, negatives included', () => {
    const labels = labelsFor([8_000, -9_000, 0, 12_000, 25_000, 0, -4_000, 15_000, 7_000, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT, 8)).toBe(true)
  })

  it('falls back to the single latest label once a decimal negative would collide', () => {
    // "-3,4 tn" is the widest common shape: seven glyphs beside a neighbour.
    const labels = labelsFor([8_200, -3_400, -3_400, 12_000, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT, 3)).toBe(false)
  })

  it('falls back for six-figure months', () => {
    const labels = labelsFor([123_000, -198_000, 45_000, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(allLabelsFit(labels, SLOT, 2)).toBe(false)
  })

  it('measures the latest bar at its larger font when testing its neighbours', () => {
    // "8,2 tn" next to "8,2 tn": fine at the small size on both, too wide
    // once the right-hand one is the emphasised latest label.
    const labels = labelsFor([8_200, 8_200])
    expect(allLabelsFit(labels, SLOT)).toBe(true)
    expect(allLabelsFit(labels, SLOT, 1)).toBe(false)
  })

  it('never lets a single label run past its own slot, even with empty neighbours', () => {
    expect(allLabelsFit(labelsFor([-123_000, 0, 0]), SLOT)).toBe(false)
  })

  it('ignores empty labels and treats an all-zero year as fitting', () => {
    expect(allLabelsFit(['', '', ''], SLOT, 2)).toBe(true)
  })

  it('scales with the slot width, so fewer months allow wider labels', () => {
    const wide = labelsFor([-123_000, 145_000])
    expect(allLabelsFit(wide, SLOT, 1)).toBe(false)
    expect(allLabelsFit(wide, 320 / 4, 1)).toBe(true)
  })
})
