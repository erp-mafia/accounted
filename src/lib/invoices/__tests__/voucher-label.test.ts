import { describe, it, expect } from 'vitest'
import { parseVoucherNumber, voucherNumberMatches } from '../voucher-label'

describe('parseVoucherNumber', () => {
  it.each([
    ['A17', { series: 'A', number: 17 }],
    ['a17', { series: 'A', number: 17 }],
    ['A-17', { series: 'A', number: 17 }],
    ['A 17', { series: 'A', number: 17 }],
    [' A - 17 ', { series: 'A', number: 17 }],
    ['LÖ12', { series: 'LÖ', number: 12 }],
    ['A_IM-7', { series: 'A_IM', number: 7 }],
    // A series that ends in a digit is named with the picker's own hyphen form.
    ['SAVEQ4-12', { series: 'SAVEQ4', number: 12 }],
    ['17', { series: null, number: 17 }],
  ])('reads %s', (text, expected) => {
    expect(parseVoucherNumber(text)).toEqual(expected)
  })

  it.each(['', '   ', 'Konstaterade kundförluster', 'A', 'A-', '0', 'A-0', '12.5', 'A-17-1'])(
    'names no voucher in %j',
    (text) => {
      expect(parseVoucherNumber(text)).toBeNull()
    },
  )

  it('reads null and undefined as nothing', () => {
    expect(parseVoucherNumber(null)).toBeNull()
    expect(parseVoucherNumber(undefined)).toBeNull()
  })
})

describe('voucherNumberMatches', () => {
  it('matches the number in the named series, whatever its case', () => {
    expect(voucherNumberMatches({ series: 'A', number: 17 }, 'A', 17)).toBe(true)
    expect(voucherNumberMatches({ series: 'A', number: 17 }, 'a', 17)).toBe(true)
    expect(voucherNumberMatches({ series: 'A', number: 17 }, 'B', 17)).toBe(false)
    expect(voucherNumberMatches({ series: 'A', number: 17 }, 'A', 170)).toBe(false)
  })

  it('without a series matches the number in every series', () => {
    expect(voucherNumberMatches({ series: null, number: 17 }, 'B', 17)).toBe(true)
    expect(voucherNumberMatches({ series: null, number: 17 }, null, 17)).toBe(true)
    expect(voucherNumberMatches({ series: null, number: 17 }, 'B', null)).toBe(false)
  })
})
