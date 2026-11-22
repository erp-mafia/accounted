import { describe, it, expect } from 'vitest'
import { mapFortnoxToSupplierInvoice, mapFortnoxToSalesInvoice } from '../mapper'

/**
 * Fortnox names the booking voucher on the detail form of a booked customer
 * invoice as VoucherSeries + VoucherNumber (+ VoucherYear), and on a supplier
 * invoice as the SUPPLIERINVOICE reference in Vouchers. The migration links the
 * imported invoice to the SIE-imported verifikat through the pair (#1463).
 * VoucherYear is deliberately NOT read: the invoice date resolves the fiscal
 * year on our side.
 */

function salesRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DocumentNumber: '200',
    Total: 1000,
    Net: 800,
    TotalVAT: 200,
    InvoiceDate: '2026-01-10',
    DueDate: '2026-02-10',
    CustomerName: 'Kund AB',
    Sent: true,
    Booked: true,
    ...over,
  }
}

function supplierRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    GivenNumber: '100',
    Total: 1000,
    Net: 800,
    TotalVAT: 200,
    InvoiceDate: '2026-01-10',
    DueDate: '2026-02-10',
    SupplierName: 'Leverantör AB',
    Booked: true,
    ...over,
  }
}

describe('mapFortnoxToSalesInvoice: sourceVoucher', () => {
  it('reads VoucherSeries + VoucherNumber and ignores VoucherYear', () => {
    const dto = mapFortnoxToSalesInvoice(salesRaw({ VoucherSeries: 'A', VoucherNumber: 329, VoucherYear: 3 }))
    expect(dto.sourceVoucher).toEqual({ series: 'A', number: 329 })
  })

  it('leaves sourceVoucher undefined on the list form (no voucher fields)', () => {
    expect(mapFortnoxToSalesInvoice(salesRaw()).sourceVoucher).toBeUndefined()
  })

  it('leaves sourceVoucher undefined for an unbooked invoice (VoucherNumber 0)', () => {
    const dto = mapFortnoxToSalesInvoice(salesRaw({ Booked: false, VoucherSeries: '', VoucherNumber: 0 }))
    expect(dto.sourceVoucher).toBeUndefined()
  })
})

describe('mapFortnoxToSupplierInvoice: sourceVoucher', () => {
  it('reads VoucherSeries + VoucherNumber', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({ VoucherSeries: 'B', VoucherNumber: '41', VoucherYear: 3 }))
    expect(dto.sourceVoucher).toEqual({ series: 'B', number: 41 })
  })

  it('leaves sourceVoucher undefined when absent or malformed', () => {
    expect(mapFortnoxToSupplierInvoice(supplierRaw()).sourceVoucher).toBeUndefined()
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ VoucherSeries: 'B', VoucherNumber: 'x' })).sourceVoucher).toBeUndefined()
  })

  // Fortnox names a supplier invoice's booking in `Vouchers`; the top-level
  // fields are filled only in the bookkeep response. A migration that read
  // only those found no booking for any supplier invoice, so none was linked
  // to the SIE verifikat that booked it and each offered Bokför again.
  it('reads the SUPPLIERINVOICE reference in Vouchers, as an invoice read from Fortnox carries it', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({
      Total: 4680,
      Vouchers: [
        { Number: 64, Series: 'D', Year: 10, ReferenceType: 'SUPPLIERINVOICE' },
        { Number: 70, Series: 'E', Year: 10, ReferenceType: 'SUPPLIERPAYMENT' },
      ],
    }))
    expect(dto.sourceVoucher).toEqual({ series: 'D', number: 64 })
  })

  it('reads a reference whose number arrives as a string', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({
      Vouchers: [{ Number: '64', Series: 'd', Year: 10, ReferenceType: 'SUPPLIERINVOICE' }],
    }))
    expect(dto.sourceVoucher).toEqual({ series: 'D', number: 64 })
  })

  it('never guesses between two SUPPLIERINVOICE references', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({
      VoucherSeries: 'D',
      VoucherNumber: 64,
      Vouchers: [
        { Number: 64, Series: 'D', Year: 10, ReferenceType: 'SUPPLIERINVOICE' },
        { Number: 65, Series: 'D', Year: 10, ReferenceType: 'SUPPLIERINVOICE' },
      ],
    }))
    expect(dto.sourceVoucher).toBeUndefined()
  })

  it('names no booking when Vouchers holds only payments', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({
      Vouchers: [{ Number: 70, Series: 'E', Year: 10, ReferenceType: 'SUPPLIERPAYMENT' }],
    }))
    expect(dto.sourceVoucher).toBeUndefined()
  })
})
