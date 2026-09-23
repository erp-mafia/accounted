import { describe, it, expect } from 'vitest'
import { locateQuote } from '../locate'

const pages = [
  { pageNo: 1, text: 'HYRESAVTAL\nHyresvärd: Fastighets AB Kvarnen\nHyra: 12 500 kr per månad exkl. moms', words: [
    { t: 'HYRESAVTAL', x0: 50, y0: 40, x1: 150, y1: 52 },
    { t: 'Hyresvärd: Fastighets AB Kvarnen', x0: 50, y0: 70, x1: 260, y1: 82 },
    { t: 'Hyra: 12 500 kr', x0: 50, y0: 100, x1: 140, y1: 112 },
    { t: 'per månad exkl. moms', x0: 145, y0: 100, x1: 280, y1: 112 },
  ] },
  { pageNo: 2, text: 'Avtalstiden löper från 2026-01-01 till 2028-12-31.', words: null },
]

describe('locateQuote', () => {
  it('finds the page and the union box of the matching runs', () => {
    const out = locateQuote(pages, '12 500 kr per månad', 1)
    expect(out.page).toBe(1)
    expect(out.bbox).toEqual({ x0: 50, y0: 100, x1: 280, y1: 112 })
  })

  it('corrects a wrong page claim from the text', () => {
    expect(locateQuote(pages, 'löper från 2026-01-01', 1)).toEqual({ page: 2, bbox: null })
  })

  it('falls back to the first half of a paraphrased quote', () => {
    const out = locateQuote(pages, 'Hyresvärd: Fastighets AB Kvarnen, org.nr 556000-0000', 2)
    expect(out.page).toBe(1)
    expect(out.bbox).toEqual({ x0: 50, y0: 70, x1: 260, y1: 82 })
  })

  it('keeps the claim when nothing matches, and passes null quotes through', () => {
    expect(locateQuote(pages, 'text that is not there at all', 2)).toEqual({ page: 2, bbox: null })
    expect(locateQuote(pages, null, 1)).toEqual({ page: 1, bbox: null })
  })
})
