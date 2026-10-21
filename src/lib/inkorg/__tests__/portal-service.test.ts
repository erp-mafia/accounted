import { describe, expect, it } from 'vitest'
import { portalSupplierOf } from '../portal-service'

const row = (description: string | null, merchant_name: string | null = null) => ({ description, merchant_name })

describe('portalSupplierOf: the supplier a portal is saved for', () => {
  it('keys the same supplier on every row, autogiro included', () => {
    expect(portalSupplierOf(row('TELIA SVERIGE AB'))).toEqual({ key: 'telia sverige', vendor: 'Telia' })
    expect(portalSupplierOf(row('TELIA SVERIGE AB AUTOGIRO'))).toEqual({ key: 'telia sverige', vendor: 'Telia' })
  })

  it("names it by the vendor's own title when its mark is known, else by the row without legal form, rail or card token", () => {
    expect(portalSupplierOf(row('TELIA SVERIGE AB', 'Telia Sverige AB'))?.vendor).toBe('Telia')
    expect(portalSupplierOf(row('ELLEVIO AB AUTOGIRO'))?.vendor).toBe('Ellevio')
    expect(portalSupplierOf(row('PAPPERSSLADAN K3667'))?.vendor).toBe('Papperssladan')
    expect(portalSupplierOf(row('HYRA KONTOR OKTOBER'))?.vendor).toBe('Hyra Kontor Oktober')
  })

  it('keeps the name short enough for the view key', () => {
    const long = 'A'.repeat(120)
    expect(portalSupplierOf(row(long))?.vendor.length).toBeLessThanOrEqual(80)
  })

  it('saves nothing for salary, tax, a row that names nobody, or no text at all', () => {
    expect(portalSupplierOf(row('Lön Juli Jakob'))).toBeNull()
    expect(portalSupplierOf(row('Skatt lön Juni BG 0000050501055'))).toBeNull()
    expect(portalSupplierOf(row('INTERNET BET 4'))).toBeNull()
    expect(portalSupplierOf(row(null, '  '))).toBeNull()
    expect(portalSupplierOf(row('AB'))).toBeNull()
  })
})
