import { describe, it, expect } from 'vitest'
import { pdfAmount, pdfNumberText, pdfText, pdfTextDeep, UNICODE_MINUS } from '../number-text'

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

describe('pdfText', () => {
  it('maps every U+2212 in free text to the ASCII hyphen-minus', () => {
    expect(pdfText(`bruttolön ${UNICODE_MINUS} skatt ${UNICODE_MINUS} nettoavdrag`)).toBe(
      'bruttolön - skatt - nettoavdrag'
    )
    expect(pdfText(`${UNICODE_MINUS}(full lön ${UNICODE_MINUS} sjuklön + karensavdrag)`)).toBe(
      '-(full lön - sjuklön + karensavdrag)'
    )
  })

  it('does not treat the text as a number', () => {
    // A formula that happens to start with "-0" keeps its sign.
    expect(pdfText(`${UNICODE_MINUS}0,5 × lön`)).toBe('-0,5 × lön')
    expect(pdfText('grundlön + tillägg')).toBe('grundlön + tillägg')
    expect(pdfText('')).toBe('')
  })
})

describe('pdfTextDeep', () => {
  it('maps U+2212 in every string of nested report data and leaves the rest as it was', () => {
    const data = {
      text: `förlust ${UNICODE_MINUS}1 250 kr`,
      amount: -1250,
      missing: null,
      flag: true,
      notes: [{ number: 1, body: `${UNICODE_MINUS}3 kr`, tags: [`a${UNICODE_MINUS}b`] }],
    }
    expect(pdfTextDeep(data)).toEqual({
      text: 'förlust -1 250 kr',
      amount: -1250,
      missing: null,
      flag: true,
      notes: [{ number: 1, body: '-3 kr', tags: ['a-b'] }],
    })
  })

  it('returns a copy: the data it was given keeps its text', () => {
    const data = { text: `${UNICODE_MINUS}1`, rows: [`${UNICODE_MINUS}2`] }
    const safe = pdfTextDeep(data)
    expect(safe).not.toBe(data)
    expect(data.text).toBe(`${UNICODE_MINUS}1`)
    expect(data.rows[0]).toBe(`${UNICODE_MINUS}2`)
  })
})

describe('pdfAmount', () => {
  // The PDF templates that used to inline this Intl call now share it, so the
  // contract they print by is pinned here.
  it('prints two decimals with sv-SE grouping and an ASCII minus', () => {
    expect(pdfAmount(1234.5)).toMatch(/^1\s234,50$/)
    expect(pdfAmount(-50)).toBe('-50,00')
    expect(pdfAmount(-1234.5)).toMatch(/^-1\s234,50$/)
    expect(pdfAmount(0)).toBe('0,00')
    expect(pdfAmount(-1234.5)).not.toContain(UNICODE_MINUS)
  })

  it('prints a negative zero and sub-öre noise unsigned', () => {
    expect(pdfAmount(-0)).toBe('0,00')
    expect(pdfAmount(-0.004)).toBe('0,00')
    expect(pdfAmount(-0.005)).toBe('-0,01')
  })

  it('is the same text as pdfNumberText over the sv-SE two-decimal format', () => {
    const intl = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    for (const n of [0, -0, 1.005, -1.005, 2.675, -2.675, 1e9 + 0.5, -0.001, 18563, -18563.456]) {
      expect(pdfAmount(n)).toBe(pdfNumberText(intl.format(n)))
    }
  })
})
