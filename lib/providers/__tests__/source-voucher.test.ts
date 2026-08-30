import { describe, it, expect } from 'vitest'
import { parseSourceVoucherRef, sourceVoucherFromParts } from '../source-voucher'

/**
 * The parser feeds the registration-voucher link (#1463). A false positive
 * here becomes a wrong verifikat link on a migrated invoice, so garbage must
 * come out as null, never as a best-effort number.
 */
describe('parseSourceVoucherRef', () => {
  it('reads the Visma spelling with the series glued to the number', () => {
    expect(parseSourceVoucherRef('A329')).toEqual({ series: 'A', number: 329 })
  })

  it('accepts a space or hyphen between series and number, and lowercase series', () => {
    expect(parseSourceVoucherRef('A 329')).toEqual({ series: 'A', number: 329 })
    expect(parseSourceVoucherRef('a-329')).toEqual({ series: 'A', number: 329 })
    expect(parseSourceVoucherRef('  B12 ')).toEqual({ series: 'B', number: 12 })
  })

  it('reads a bare number as series-less', () => {
    expect(parseSourceVoucherRef('329')).toEqual({ series: null, number: 329 })
    expect(parseSourceVoucherRef(329)).toEqual({ series: null, number: 329 })
  })

  it('returns null on anything it cannot read with certainty', () => {
    expect(parseSourceVoucherRef(undefined)).toBeNull()
    expect(parseSourceVoucherRef(null)).toBeNull()
    expect(parseSourceVoucherRef('')).toBeNull()
    expect(parseSourceVoucherRef('   ')).toBeNull()
    expect(parseSourceVoucherRef('A')).toBeNull()
    expect(parseSourceVoucherRef('A329B')).toBeNull()
    expect(parseSourceVoucherRef('12.5')).toBeNull()
    expect(parseSourceVoucherRef('0')).toBeNull()
    expect(parseSourceVoucherRef('-5')).toBeNull()
    expect(parseSourceVoucherRef('Verifikation A329')).toBeNull()
    expect(parseSourceVoucherRef(3.5)).toBeNull()
    expect(parseSourceVoucherRef({ VoucherNumber: 'A1' })).toBeNull()
  })
})

describe('sourceVoucherFromParts', () => {
  it('reads the Fortnox split form', () => {
    expect(sourceVoucherFromParts('A', 329)).toEqual({ series: 'A', number: 329 })
    expect(sourceVoucherFromParts('a', '329')).toEqual({ series: 'A', number: 329 })
  })

  it('tolerates a missing series but not a missing or zero number', () => {
    expect(sourceVoucherFromParts(undefined, 7)).toEqual({ series: null, number: 7 })
    expect(sourceVoucherFromParts('', 7)).toEqual({ series: null, number: 7 })
    expect(sourceVoucherFromParts('A', 0)).toBeNull()
    expect(sourceVoucherFromParts('A', undefined)).toBeNull()
    expect(sourceVoucherFromParts('A', null)).toBeNull()
    expect(sourceVoucherFromParts('A', 'x')).toBeNull()
    expect(sourceVoucherFromParts('A', 1.5)).toBeNull()
  })
})
