import { describe, expect, it } from 'vitest'
import {
  SUPPLIER_INVOICE_TOTALS_TOLERANCE,
  exceedsSupplierInvoiceTotalsTolerance,
  readSupplierInvoiceLinesAsGross,
  supplierInvoiceLinesInclVat,
  supplierInvoiceTotalsGap,
  supplierInvoiceTotalsTolerance,
} from '../supplier-invoice-line-totals'

// Feedback seq 983757: a bill that printed its line amounts incl. VAT was
// staged as if they were net, and 25 % was added on top again. Synthetic
// figures: a 1 412.62 line incl. 25 % VAT and a 75.00 fee at 0 %, billed
// 1 488.00 after öresavrundning.
const grossLine = { line_total: 1412.62, unit_price: 1412.62, vat_rate: 0.25, vat_amount: 353.16 }
const feeLine = { line_total: 75, unit_price: 75, vat_rate: 0, vat_amount: 0 }
const printedGross = { amount: 1412.62, rate: 0.25, deductible: true }
const printedFee = { amount: 75, rate: 0, deductible: false }

describe('supplierInvoiceTotalsGap', () => {
  it('is the document total minus the lines incl. VAT, to the öre', () => {
    expect(supplierInvoiceLinesInclVat([grossLine, feeLine])).toBe(1840.78)
    expect(supplierInvoiceTotalsGap(1488, [grossLine, feeLine])).toBe(-352.78)
    expect(supplierInvoiceTotalsGap(1250, [{ line_total: 1000, vat_amount: 250 }])).toBe(0)
  })
})

describe('supplierInvoiceTotalsTolerance', () => {
  it('is half a krona plus half an öre per line, capped at 2.00', () => {
    expect(SUPPLIER_INVOICE_TOTALS_TOLERANCE).toBe(0.5)
    expect(supplierInvoiceTotalsTolerance(0)).toBe(0.5)
    expect(supplierInvoiceTotalsTolerance(2)).toBe(0.51)
    expect(supplierInvoiceTotalsTolerance(120)).toBe(1.1)
    expect(supplierInvoiceTotalsTolerance(1000)).toBe(2)
  })

  it('refuses only past the tolerance, on either side', () => {
    expect(exceedsSupplierInvoiceTotalsTolerance(0.5, 0)).toBe(false)
    expect(exceedsSupplierInvoiceTotalsTolerance(-0.5, 0)).toBe(false)
    expect(exceedsSupplierInvoiceTotalsTolerance(0.51, 0)).toBe(true)
    expect(exceedsSupplierInvoiceTotalsTolerance(-0.51, 0)).toBe(true)
    expect(exceedsSupplierInvoiceTotalsTolerance(0.51, 2)).toBe(false)
    expect(exceedsSupplierInvoiceTotalsTolerance(0.52, 2)).toBe(true)
  })

  it('absorbs the per-line VAT rounding of a long invoice: 120 lines of 9.98 at 25 %', () => {
    // Line by line 120 x 2.50 = 300.00; the document's VAT on the sum is 299.40.
    const lines = Array.from({ length: 120 }, () => ({ line_total: 9.98, vat_amount: 2.5 }))
    const gap = supplierInvoiceTotalsGap(1497, lines)
    expect(gap).toBe(-0.6)
    expect(exceedsSupplierInvoiceTotalsTolerance(gap, lines.length)).toBe(false)
    expect(exceedsSupplierInvoiceTotalsTolerance(gap - 1, lines.length)).toBe(true)
  })
})

describe('readSupplierInvoiceLinesAsGross', () => {
  it('splits the VAT out of each line when the amounts sum to the total and their VAT to the document VAT', () => {
    const read = readSupplierInvoiceLinesAsGross([grossLine, feeLine], [printedGross, printedFee], 1488, 282.52)

    expect(read).not.toBeNull()
    expect(read!.grossSum).toBe(1487.62)
    expect(read!.vatSum).toBe(282.52)
    expect(read!.lines[0]).toEqual({ line_total: 1130.1, unit_price: 1130.1, vat_rate: 0.25, vat_amount: 282.52 })
    expect(read!.lines[1]).toEqual(feeLine)
    // net + VAT is the printed amount exactly; what is left is öresavrundning.
    expect(supplierInvoiceTotalsGap(1488, read!.lines)).toBe(0.38)
  })

  it('scales the unit price with the line', () => {
    const read = readSupplierInvoiceLinesAsGross(
      [{ line_total: 250, unit_price: 125, vat_rate: 0.25, vat_amount: 62.5 }],
      [{ amount: 250, rate: 0.25, deductible: true }],
      250,
      50,
    )
    expect(read!.lines[0]).toMatchObject({ line_total: 200, unit_price: 100, vat_amount: 50 })
  })

  it('handles the reduced rates line by line', () => {
    const read = readSupplierInvoiceLinesAsGross(
      [
        { line_total: 112, unit_price: 112, vat_rate: 0.12, vat_amount: 13.44 },
        { line_total: 106, unit_price: 106, vat_rate: 0.06, vat_amount: 6.36 },
      ],
      [
        { amount: 112, rate: 0.12, deductible: true },
        { amount: 106, rate: 0.06, deductible: true },
      ],
      218,
      18,
    )
    expect(read!.lines.map((l) => [l.line_total, l.vat_amount])).toEqual([[100, 12], [100, 6]])
  })

  it('keeps a foreign-rate line whole as cost: its VAT is not deductible here', () => {
    // 119.00 printed incl. 19 % foreign VAT, priced net as 119 + 22.61 = 141.61.
    const read = readSupplierInvoiceLinesAsGross(
      [{ line_total: 141.61, unit_price: 141.61, vat_rate: 0, vat_amount: 0 }],
      [{ amount: 119, rate: 0.19, deductible: false }],
      119,
      19,
    )
    expect(read!.lines[0]).toEqual({ line_total: 119, unit_price: 119, vat_rate: 0, vat_amount: 0 })
    expect(read!.vatSum).toBe(19)
  })

  it('refuses when the line amounts do not reach the total', () => {
    expect(readSupplierInvoiceLinesAsGross([grossLine, feeLine], [printedGross, printedFee], 1600, 282.52)).toBeNull()
  })

  it('refuses when the VAT inside the lines does not match the document VAT', () => {
    expect(readSupplierInvoiceLinesAsGross([grossLine, feeLine], [printedGross, printedFee], 1488, 0)).toBeNull()
    expect(readSupplierInvoiceLinesAsGross([grossLine, feeLine], [printedGross, printedFee], 1488, 353.16)).toBeNull()
  })

  it('refuses when there is no VAT to split out', () => {
    expect(readSupplierInvoiceLinesAsGross([feeLine], [printedFee], 75, 0)).toBeNull()
  })
})
