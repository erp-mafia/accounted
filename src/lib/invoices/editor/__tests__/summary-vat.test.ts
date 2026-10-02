import { describe, it, expect } from 'vitest'
import { buildSummaryVatLines, zeroVatReason } from '../summary-vat'

describe('zeroVatReason', () => {
  it('names reverse charge and export, and calls any other 0 % momsfri', () => {
    expect(zeroVatReason('reverse_charge')).toBe('reverse_charge')
    expect(zeroVatReason('export')).toBe('export')
    expect(zeroVatReason('standard_25')).toBe('exempt')
    expect(zeroVatReason('exempt')).toBe('exempt')
  })
})

describe('buildSummaryVatLines', () => {
  it('shows one Moms line for a domestic invoice at one rate', () => {
    expect(
      buildSummaryVatLines({
        vatRegistered: true,
        treatment: 'standard_25',
        groups: [{ rate: 25, base: 1000, vat: 250 }],
      }),
    ).toEqual([{ kind: 'vat', rate: 25, amount: 250, reason: null }])
  })

  it('shows Moms 0 % with omvänd skattskyldighet on a reverse-charge invoice', () => {
    expect(
      buildSummaryVatLines({
        vatRegistered: true,
        treatment: 'reverse_charge',
        groups: [{ rate: 0, base: 4200, vat: 0 }],
      }),
    ).toEqual([{ kind: 'vat', rate: 0, amount: 0, reason: 'reverse_charge' }])
  })

  it('names export and momsfri for their 0 % lines', () => {
    expect(
      buildSummaryVatLines({ vatRegistered: true, treatment: 'export', groups: [{ rate: 0, base: 900, vat: 0 }] }),
    ).toEqual([{ kind: 'vat', rate: 0, amount: 0, reason: 'export' }])
    expect(
      buildSummaryVatLines({ vatRegistered: true, treatment: 'standard_25', groups: [{ rate: 0, base: 900, vat: 0 }] }),
    ).toEqual([{ kind: 'vat', rate: 0, amount: 0, reason: 'exempt' }])
  })

  it('gives no VAT line at all when the seller is not VAT registered', () => {
    expect(
      buildSummaryVatLines({ vatRegistered: false, treatment: 'exempt', groups: [{ rate: 0, base: 900, vat: 0 }] }),
    ).toEqual([])
  })

  it('splits a mixed invoice per rate, highest first, keeping the 0 % reason', () => {
    expect(
      buildSummaryVatLines({
        vatRegistered: true,
        treatment: 'reverse_charge',
        groups: [
          { rate: 0, base: 2000, vat: 0 },
          { rate: 12, base: 1000, vat: 120 },
        ],
      }),
    ).toEqual([
      { kind: 'net', rate: 12, amount: 1000 },
      { kind: 'vat', rate: 12, amount: 120, reason: null },
      { kind: 'net', rate: 0, amount: 2000 },
      { kind: 'vat', rate: 0, amount: 0, reason: 'reverse_charge' },
    ])
  })

  it('ignores a rate only an empty row carries', () => {
    expect(
      buildSummaryVatLines({
        vatRegistered: true,
        treatment: 'standard_25',
        groups: [
          { rate: 25, base: 1000, vat: 250 },
          { rate: 0, base: 0, vat: 0 },
        ],
      }),
    ).toEqual([{ kind: 'vat', rate: 25, amount: 250, reason: null }])
  })

  it('keeps a plain Moms 0 line while nothing is priced yet', () => {
    expect(buildSummaryVatLines({ vatRegistered: true, treatment: 'standard_25', groups: [] })).toEqual([
      { kind: 'vat', rate: null, amount: 0, reason: null },
    ])
    expect(
      buildSummaryVatLines({ vatRegistered: true, treatment: 'standard_25', groups: [{ rate: 25, base: 0, vat: 0 }] }),
    ).toEqual([{ kind: 'vat', rate: null, amount: 0, reason: null }])
  })

  it('shows the 0 % reason before any price on a reverse-charge invoice', () => {
    expect(
      buildSummaryVatLines({ vatRegistered: true, treatment: 'reverse_charge', groups: [{ rate: 0, base: 0, vat: 0 }] }),
    ).toEqual([{ kind: 'vat', rate: 0, amount: 0, reason: 'reverse_charge' }])
  })

  it('shows negative VAT (a credit-like row) rather than hiding it', () => {
    expect(
      buildSummaryVatLines({ vatRegistered: true, treatment: 'standard_25', groups: [{ rate: 25, base: -400, vat: -100 }] }),
    ).toEqual([{ kind: 'vat', rate: 25, amount: -100, reason: null }])
  })
})
