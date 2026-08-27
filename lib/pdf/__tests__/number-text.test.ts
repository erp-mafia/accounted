import { describe, it, expect } from 'vitest'
import { pdfNumberText, UNICODE_MINUS } from '../number-text'

describe('pdfNumberText', () => {
  it('maps every U+2212 to the ASCII hyphen-minus', () => {
    const formatted = (-4684.24).toLocaleString('sv-SE', { minimumFractionDigits: 2 })
    expect(formatted).toContain(UNICODE_MINUS)
    const safe = pdfNumberText(formatted)
    expect(safe).not.toContain(UNICODE_MINUS)
    expect(safe.startsWith('-4')).toBe(true)
    expect(pdfNumberText(`${UNICODE_MINUS}1 ${UNICODE_MINUS}2`)).toBe('-1 -2')
  })

  it('prints a negative zero unsigned', () => {
    expect(pdfNumberText((-0).toLocaleString('sv-SE'))).toBe('0')
    expect(pdfNumberText(`${UNICODE_MINUS}0,00`)).toBe('0,00')
    expect(pdfNumberText('-0.00')).toBe('0.00')
    // A real small negative keeps its sign.
    expect(pdfNumberText(`${UNICODE_MINUS}0,01`)).toBe('-0,01')
  })

  it('leaves text without a minus sign untouched', () => {
    expect(pdfNumberText('20 316')).toBe('20 316')
    expect(pdfNumberText('')).toBe('')
  })
})
