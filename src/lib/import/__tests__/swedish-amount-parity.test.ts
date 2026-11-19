/**
 * parseSwedishAmount against the copies it replaced.
 *
 * Every bank format, the skattekonto export and the opening-balance sheet
 * carried its own amount parser. The copies are kept here verbatim, and every
 * amount a real file carries must read the same through the one parser. The
 * cases where the copies disagreed with each other (and so with the one rule)
 * are listed below with what each copy did, and pinned to the corrected value.
 */
import { describe, expect, it } from 'vitest'
import { parseSwedishAmount } from '@/lib/money'

const normalizeMinusSign = (value: string) => value.replace(/[−‒–—―﹣－]/g, '-')

/** handelsbanken.ts, northmill.ts */
const commaDecimalWithMinus = (value: string) =>
  parseFloat(normalizeMinusSign(value).replace(/\s/g, '').replace(',', '.'))
/** ica-banken, lansforsakringar, nordea, nordea-business, seb, skandia */
const commaDecimal = (value: string) => parseFloat(value.replace(/\s/g, '').replace(',', '.'))
/** lunar.ts */
const lunar = (value: string) => {
  const cleaned = value.replace(/[\s  .]/g, '').replace(',', '.')
  if (cleaned === '') return NaN
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : NaN
}
/** wise.ts, wise-statement.ts */
const wise = (value: string | undefined) => {
  if (!value) return NaN
  const cleaned = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN
  return parseFloat(cleaned)
}
/** skattekonto-file/parser.ts */
const skattekonto = (value: string): number | null => {
  const cleaned = value
    .replace(/\s/g, '')
    .replace(/kr$/i, '')
    .replace(/^[−‐-–]/, '-')
    .replace(/^\+/, '')
    .replace(',', '.')
  if (cleaned === '' || cleaned === '-') return null
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return Math.round(parseFloat(cleaned) * 100) / 100
}
/** opening-balance/parser.ts */
const openingBalance = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Math.round(value * 100) / 100
  const str = String(value).trim()
  if (str === '' || str === '-') return 0
  const cleaned = str.replace(/\s/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.')
  const num = parseFloat(cleaned)
  if (isNaN(num)) return 0
  return Math.round(num * 100) / 100
}

const asNaN = (n: number | null) => (n === null ? NaN : n)

describe('parseSwedishAmount: parity with the bank parsers', () => {
  // What the Swedish banks' CSV exports carry.
  const commaCases = ['1 234,56', '-1 234,56', '1234,56', '-139,00', '400000,00', '0,00', '12 345,67', '-12 345,67', '15', '-0,50']

  it.each(commaCases)('reads %s as every comma-decimal copy did', (value) => {
    expect(asNaN(parseSwedishAmount(value))).toBe(commaDecimal(value))
    expect(asNaN(parseSwedishAmount(value))).toBe(commaDecimalWithMinus(value))
  })

  it.each(['12 345,00', '1.234,56', '-1.234,56', '99,9'])('reads Lunar %s as before', (value) => {
    expect(asNaN(parseSwedishAmount(value))).toBe(lunar(value))
  })

  it.each(['12.34', '-12.34', '1234', '0.5', '-1000.00'])('reads Wise %s as before', (value) => {
    expect(asNaN(parseSwedishAmount(value))).toBe(wise(value))
  })

  it.each(['', 'abc', '-'])('refuses %j where the copies yielded NaN', (value) => {
    expect(parseSwedishAmount(value)).toBeNull()
    expect(commaDecimal(value)).toBeNaN()
  })
})

describe('parseSwedishAmount: parity with the skattekonto parser', () => {
  it.each(['-1 234 kr', '+2 500', '−1 000,50', '–5 000', '12 345,67 kr', '0', '-', '', 'Saldo'])(
    'reads %j as before',
    (value) => {
      expect(parseSwedishAmount(value)).toBe(skattekonto(value))
    },
  )
})

describe('parseSwedishAmount: parity with the opening-balance parser', () => {
  it.each([1234.567, '1 234,56', '1.234', '1.234,56', '-15 000', '0', 250, '12,5'])('reads %j as before', (value) => {
    expect(parseSwedishAmount(value) ?? 0).toBe(openingBalance(value))
  })
})

describe('parseSwedishAmount: where the copies disagreed', () => {
  it('reads a Unicode minus on every bank, which six copies turned into NaN (a dropped row)', () => {
    expect(commaDecimal('−139,00')).toBeNaN()
    expect(parseSwedishAmount('−139,00')).toBe(-139)
  })

  it('reads dot-grouped thousands with a decimal comma, which six copies read as 1.234', () => {
    expect(commaDecimal('1.234,56')).toBe(1.234)
    expect(parseSwedishAmount('1.234,56')).toBe(1234.56)
  })

  it('refuses trailing text or a second decimal mark instead of reading the leading digits', () => {
    expect(commaDecimal('100,00 SEK')).toBe(100)
    expect(parseSwedishAmount('100,00 SEK')).toBeNull()
    expect(commaDecimal('12,3,4')).toBe(12.3)
    expect(parseSwedishAmount('12,3,4')).toBeNull()
  })

  it('rounds every amount to the öre, as the skattekonto and opening-balance copies did', () => {
    expect(parseSwedishAmount('10,075')).toBe(10.08)
    expect(parseSwedishAmount(0.1 + 0.2)).toBe(0.3)
  })
})
