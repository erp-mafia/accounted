import { describe, it, expect } from 'vitest'
import { mapVismaToSalesInvoice, mapVismaToSupplierInvoice } from '../mapper'

/**
 * eAccounting names the booking voucher on both invoice APIs as
 * `VoucherNumber` ("A329"). The migration links the imported invoice to the
 * SIE-imported verifikat through it (#1463), so the mapper must carry it as
 * a parsed ref, and must carry NOTHING when the field is absent or unreadable.
 */

function salesRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 's1',
    InvoiceNumber: '10060',
    InvoiceDate: '2026-07-24',
    DueDate: '2026-08-10',
    CurrencyCode: 'SEK',
    TotalAmount: 75000,
    TotalVatAmount: 15000,
    InvoiceCustomerName: 'Kund AB',
    Rows: [],
    ...over,
  }
}

function supplierRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'b1',
    InvoiceNumber: '903127919426',
    InvoiceDate: '2026-07-31',
    DueDate: '2026-08-30',
    CurrencyCode: 'SEK',
    TotalAmount: 1250,
    TotalVatAmount: 250,
    SupplierName: 'PostNord Sverige AB',
    Rows: [],
    ...over,
  }
}

describe('mapVismaToSalesInvoice: sourceVoucher', () => {
  it('parses VoucherNumber into series + number', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ VoucherNumber: 'A329' }))
    expect(dto.sourceVoucher).toEqual({ series: 'A', number: 329 })
  })

  it('keeps a bare number as series-less', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ VoucherNumber: '329' }))
    expect(dto.sourceVoucher).toEqual({ series: null, number: 329 })
  })

  it('leaves sourceVoucher undefined when the field is absent', () => {
    const dto = mapVismaToSalesInvoice(salesRaw())
    expect(dto.sourceVoucher).toBeUndefined()
  })

  it('leaves sourceVoucher undefined when the field is malformed', () => {
    expect(mapVismaToSalesInvoice(salesRaw({ VoucherNumber: '' })).sourceVoucher).toBeUndefined()
    expect(mapVismaToSalesInvoice(salesRaw({ VoucherNumber: 'n/a' })).sourceVoucher).toBeUndefined()
    expect(mapVismaToSalesInvoice(salesRaw({ VoucherNumber: null })).sourceVoucher).toBeUndefined()
  })
})

describe('mapVismaToSupplierInvoice: sourceVoucher', () => {
  it('parses VoucherNumber into series + number', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ VoucherNumber: 'B 41' }))
    expect(dto.sourceVoucher).toEqual({ series: 'B', number: 41 })
  })

  it('leaves sourceVoucher undefined when absent or malformed', () => {
    expect(mapVismaToSupplierInvoice(supplierRaw()).sourceVoucher).toBeUndefined()
    expect(mapVismaToSupplierInvoice(supplierRaw({ VoucherNumber: 'A' })).sourceVoucher).toBeUndefined()
  })
})
