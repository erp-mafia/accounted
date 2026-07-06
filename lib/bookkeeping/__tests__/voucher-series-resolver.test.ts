import { describe, it, expect } from 'vitest'
import {
  applyDefaultSeriesToMap,
  formatVoucher,
  parseVoucher,
  resolveDefaultSeriesForSource,
} from '../voucher-series-resolver'

describe('resolveDefaultSeriesForSource', () => {
  it('returns A when settings is null', () => {
    expect(resolveDefaultSeriesForSource(null, 'manual')).toBe('A')
  })

  it('returns A when settings is undefined', () => {
    expect(resolveDefaultSeriesForSource(undefined, 'manual')).toBe('A')
  })

  it('returns A when the map is missing entirely', () => {
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: null },
        'manual',
      ),
    ).toBe('A')
  })

  it('returns A when the source_type is not in the map', () => {
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: { manual: 'A' } },
        'supplier_invoice_registered',
      ),
    ).toBe('A')
  })

  it('returns the configured letter for a known source_type', () => {
    expect(
      resolveDefaultSeriesForSource(
        {
          default_voucher_series_per_source_type: {
            manual: 'A',
            supplier_invoice_registered: 'B',
            salary_payment: 'C',
          },
        },
        'supplier_invoice_registered',
      ),
    ).toBe('B')
    expect(
      resolveDefaultSeriesForSource(
        {
          default_voucher_series_per_source_type: {
            manual: 'A',
            supplier_invoice_registered: 'B',
            salary_payment: 'C',
          },
        },
        'salary_payment',
      ),
    ).toBe('C')
  })

  it('accepts a bare map (no settings wrapper)', () => {
    expect(
      resolveDefaultSeriesForSource(
        { manual: 'A', supplier_invoice_registered: 'B' },
        'supplier_invoice_registered',
      ),
    ).toBe('B')
  })

  it('rejects invalid values and falls back to A', () => {
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: { manual: 'lowercase' } },
        'manual',
      ),
    ).toBe('A')
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: { manual: 'AB' } },
        'manual',
      ),
    ).toBe('A')
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: { manual: '' } },
        'manual',
      ),
    ).toBe('A')
    expect(
      resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: { manual: '1' } },
        'manual',
      ),
    ).toBe('A')
  })
})

describe('applyDefaultSeriesToMap', () => {
  it('moves types following the old default onto the new default', () => {
    const result = applyDefaultSeriesToMap(
      { manual: 'A', invoice_paid: 'A', invoice_cash_payment: 'A' },
      'A',
      'V',
    )
    expect(result).toEqual({ manual: 'V', invoice_paid: 'V', invoice_cash_payment: 'V' })
  })

  it('preserves explicit per-type overrides that differ from the old default', () => {
    const result = applyDefaultSeriesToMap(
      { manual: 'A', supplier_invoice_paid: 'B', salary_payment: 'C' },
      'A',
      'V',
    )
    // Only the type that was following the old default (A) moves; B and C stay.
    expect(result).toEqual({ manual: 'V', supplier_invoice_paid: 'B', salary_payment: 'C' })
  })

  it('does not mutate the input map', () => {
    const input = { manual: 'A', invoice_paid: 'A' }
    applyDefaultSeriesToMap(input, 'A', 'V')
    expect(input).toEqual({ manual: 'A', invoice_paid: 'A' })
  })

  it('returns an empty map when given null/undefined', () => {
    expect(applyDefaultSeriesToMap(null, 'A', 'V')).toEqual({})
    expect(applyDefaultSeriesToMap(undefined, 'A', 'V')).toEqual({})
  })

  it('is a no-op on values when old and new default are equal', () => {
    const result = applyDefaultSeriesToMap(
      { manual: 'A', supplier_invoice_paid: 'B' },
      'A',
      'A',
    )
    expect(result).toEqual({ manual: 'A', supplier_invoice_paid: 'B' })
  })
})

describe('formatVoucher', () => {
  it('formats series + number for a posted entry', () => {
    expect(formatVoucher({ voucher_series: 'A', voucher_number: 1 })).toBe('A1')
    expect(formatVoucher({ voucher_series: 'B', voucher_number: 12 })).toBe('B12')
  })

  it('returns hyphen for null voucher_number', () => {
    expect(formatVoucher({ voucher_series: 'A', voucher_number: null })).toBe('-')
  })

  it('returns hyphen for voucher_number 0 (uncommitted draft placeholder)', () => {
    expect(formatVoucher({ voucher_series: 'A', voucher_number: 0 })).toBe('-')
  })

  it('falls back to series A when series is null', () => {
    expect(formatVoucher({ voucher_series: null, voucher_number: 5 })).toBe('A5')
  })

  it('uppercases the series', () => {
    expect(formatVoucher({ voucher_series: 'b', voucher_number: 3 })).toBe('B3')
  })
})

describe('parseVoucher', () => {
  it('parses a well-formed label', () => {
    expect(parseVoucher('A1')).toEqual({ series: 'A', number: 1 })
    expect(parseVoucher('B12')).toEqual({ series: 'B', number: 12 })
  })

  it('round-trips with formatVoucher', () => {
    const label = formatVoucher({ voucher_series: 'C', voucher_number: 42 })
    expect(parseVoucher(label)).toEqual({ series: 'C', number: 42 })
  })

  it('uppercases and trims input', () => {
    expect(parseVoucher('  a5 ')).toEqual({ series: 'A', number: 5 })
  })

  it('returns null for malformed input', () => {
    expect(parseVoucher('')).toBeNull()
    expect(parseVoucher('-')).toBeNull()
    expect(parseVoucher('123')).toBeNull()
    expect(parseVoucher('AA1')).toBeNull()
    expect(parseVoucher('A0')).toBeNull()
    expect(parseVoucher('A-1')).toBeNull()
  })
})
